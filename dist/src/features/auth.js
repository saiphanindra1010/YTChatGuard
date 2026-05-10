"use strict";
/**
 * YouTube OAuth + Data API helpers.
 *
 * googleapis typings are intentionally loose here (`@ts-nocheck`) because the
 * generated client overloads churn between releases while runtime params stay stable.
 */
// @ts-nocheck
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const googleapis_1 = require("googleapis");
const util_1 = __importDefault(require("util"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
function asGaxios(e) {
    return e != null && typeof e === 'object' ? e : {};
}
/**
 * Extract YouTube video ID from a watch URL or raw id string.
 */
function extractYouTubeVideoId(input) {
    if (!input || typeof input !== 'string')
        return null;
    const s = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s))
        return s;
    try {
        const u = new URL(s, 'https://youtube.com');
        if (u.hostname.includes('youtu.be')) {
            const id = u.pathname.replace(/^\//, '').split('/')[0];
            return id && id.length === 11 ? id : null;
        }
        const v = u.searchParams.get('v');
        if (v && v.length === 11)
            return v;
        const parts = u.pathname.split('/').filter(Boolean);
        const liveIdx = parts.indexOf('live');
        if (liveIdx >= 0 &&
            parts[liveIdx + 1] &&
            parts[liveIdx + 1].length === 11) {
            return parts[liveIdx + 1];
        }
    }
    catch {
        return null;
    }
    return null;
}
/**
 * YouTube Service with token management and error handling
 */
class YouTubeService {
    config;
    youtube = googleapis_1.google.youtube('v3');
    auth;
    _pkcePending = new Map();
    tokenPath;
    tokenManager;
    /** Current live chat API id once resolved */
    liveChatId = null;
    constructor(config) {
        this.config = config;
        this.auth = new googleapis_1.google.auth.OAuth2(String(this.config.get('youtube.clientId') ?? ''), String(this.config.get('youtube.clientSecret') ?? ''), String(this.config.get('youtube.redirectUri') ?? ''));
        this.tokenPath =
            process.env.SAFESTREAM_TOKEN_PATH ||
                process.env.YTCHATGUARD_TOKEN_PATH ||
                path_1.default.join(process.cwd(), 'src', 'tokens.json');
        this.tokenManager = new TokenManager(this.auth, this.tokenPath, config.secrets);
        console.log('YouTube Service initialized');
    }
    _prunePkceStore() {
        const ttl = 15 * 60 * 1000;
        const now = Date.now();
        for (const [k, v] of this._pkcePending.entries()) {
            if (now - v.t > ttl)
                this._pkcePending.delete(k);
        }
    }
    /**
     * Generate OAuth2 authorization URL (PKCE + state; required for secure local redirect)
     */
    async getAuthUrl() {
        this._prunePkceStore();
        const { codeVerifier, codeChallenge } = await this.auth.generateCodeVerifierAsync();
        const state = crypto_1.default.randomBytes(32).toString('base64url');
        this._pkcePending.set(state, { codeVerifier, t: Date.now() });
        const PKCE_MAX = 100;
        while (this._pkcePending.size > PKCE_MAX) {
            const oldest = this._pkcePending.keys().next().value;
            if (oldest)
                this._pkcePending.delete(oldest);
        }
        const scopesRaw = this.config.get('youtube.scopes');
        const scope = Array.isArray(scopesRaw)
            ? scopesRaw.map(String)
            : String(scopesRaw || '');
        return this.auth.generateAuthUrl({
            access_type: 'offline',
            scope,
            prompt: 'consent',
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });
    }
    /**
     * Exchange authorization code for tokens
     */
    async exchangeCodeForTokens(code, state) {
        try {
            let tokenOpts = { code: code ?? '' };
            if (state) {
                const pending = this._pkcePending.get(state);
                if (!pending) {
                    throw new Error('Sign-in session expired or invalid. Click “Sign in with Google” again.');
                }
                this._pkcePending.delete(state);
                tokenOpts = { code: code ?? '', codeVerifier: pending.codeVerifier };
            }
            const { tokens } = await this.auth.getToken(tokenOpts);
            this.auth.setCredentials(tokens);
            await this.tokenManager.saveTokens(tokens ?? {});
            console.log('Authorization successful, tokens saved');
            return tokens ?? {};
        }
        catch (error) {
            console.error('Failed to exchange code for tokens:', errMsg(error));
            throw new Error(`Authorization failed: ${errMsg(error)}`);
        }
    }
    /**
     * OAuth redirect handler (Express)
     */
    async handleCallback(code, state) {
        const c = Array.isArray(code) ? code[0] : code;
        const st = Array.isArray(state) ? state[0] : state;
        if (!c) {
            throw new Error('Missing authorization code');
        }
        if (!st) {
            throw new Error('Missing OAuth state. Start sign-in from this app again.');
        }
        await this.exchangeCodeForTokens(c, st);
        const ok = await this.initializeTokens();
        if (!ok) {
            throw new Error('Token initialization failed after sign-in');
        }
        return true;
    }
    /**
     * Resolve live chat id for a specific video (stream must be live).
     */
    async findLiveChatForVideo(videoIdOrUrl) {
        const videoId = extractYouTubeVideoId(videoIdOrUrl);
        if (!videoId) {
            throw new Error('Invalid YouTube video ID or URL');
        }
        await this.tokenManager.ensureValidTokens();
        const response = await this.youtube.videos.list({
            auth: this.auth,
            part: 'liveStreamingDetails,snippet',
            id: videoId
        });
        const item = response.data.items?.[0];
        const chatId = item?.liveStreamingDetails?.activeLiveChatId;
        if (!chatId) {
            console.log('No active live chat for video (is the stream live?)');
            return null;
        }
        this.liveChatId = chatId;
        const title = item?.snippet?.title || videoId;
        console.log(`Live chat for video ${videoId}: ${chatId} (${title})`);
        return chatId;
    }
    /**
     * Load and validate stored tokens
     */
    async initializeTokens() {
        try {
            const success = await this.tokenManager.ensureValidTokens();
            if (success) {
                console.log('YouTube tokens initialized successfully');
            }
            return success;
        }
        catch (error) {
            console.log('YouTube tokens not available:', errMsg(error));
            return false;
        }
    }
    /**
     * Find active live chat ID
     */
    async findActiveChat() {
        try {
            await this.tokenManager.ensureValidTokens();
            const response = await this.youtube.liveBroadcasts.list({
                auth: this.auth,
                part: ['snippet', 'contentDetails'],
                mine: true,
                broadcastStatus: 'active'
            });
            const broadcasts = response.data.items;
            if (!broadcasts?.length) {
                console.log('No active live broadcasts found');
                return null;
            }
            for (const broadcast of broadcasts) {
                const chatId = broadcast.snippet?.liveChatId;
                if (chatId) {
                    this.liveChatId = chatId;
                    console.log(`Active live chat found: ${this.liveChatId}`);
                    console.log(`Broadcast: ${broadcast.snippet?.title}`);
                    return this.liveChatId;
                }
            }
            console.log('No live broadcasts with chat found');
            return null;
        }
        catch (error) {
            console.error('Error finding active chat:', errMsg(error));
            const code = asGaxios(error).response?.status;
            const errCode = typeof error.code === 'number'
                ? error.code
                : code;
            if (errCode === 401) {
                console.log('Authentication expired, please re-authorize');
            }
            else if (errCode === 403) {
                console.log('Insufficient permissions or quota exceeded');
            }
            throw error;
        }
    }
    /**
     * Get live chat messages
     */
    async getChatMessages(liveChatId, pageToken = null) {
        try {
            await this.tokenManager.ensureValidTokens();
            const response = await this.youtube.liveChatMessages.list({
                auth: this.auth,
                part: ['snippet', 'authorDetails'],
                liveChatId: liveChatId || this.liveChatId || '',
                pageToken: pageToken ?? undefined,
                maxResults: 200
            });
            return response.data;
        }
        catch (error) {
            const status = asGaxios(error).response?.status;
            const numCode = error.code;
            if (status === 404 || numCode === 404) {
                console.log('Live chat ended or not found');
                this.liveChatId = null;
            }
            else if (status === 401 || numCode === 401) {
                console.log('Authentication expired during message fetch');
                await this.tokenManager.refreshTokens();
            }
            throw error;
        }
    }
    /**
     * Send message to live chat
     */
    async sendMessage(messageText, liveChatId = null) {
        try {
            await this.tokenManager.ensureValidTokens();
            const chatId = liveChatId || this.liveChatId;
            if (!chatId) {
                throw new Error('No active live chat ID available');
            }
            const response = await this.youtube.liveChatMessages.insert({
                auth: this.auth,
                part: ['snippet'],
                resource: {
                    snippet: {
                        type: 'textMessageEvent',
                        liveChatId: chatId,
                        textMessageDetails: {
                            messageText
                        }
                    }
                }
            });
            console.log('Message sent successfully');
            return response.data;
        }
        catch (error) {
            console.error('Failed to send message:', errMsg(error));
            const stat = asGaxios(error).response?.status;
            if (stat === 401) {
                console.log('Authentication expired during message send');
            }
            else if (stat === 403) {
                console.log('Insufficient permissions to send messages');
            }
            else if (stat === 400) {
                console.log('Invalid message format or chat not available');
            }
            throw error;
        }
    }
    async timeoutLiveChatUser(bannedChannelId, liveChatId = null, durationSeconds = 300) {
        await this.tokenManager.ensureValidTokens();
        const chatId = liveChatId || this.liveChatId;
        if (!chatId)
            throw new Error('No active live chat ID available');
        if (!bannedChannelId)
            throw new Error('No user channel ID to timeout');
        const sec = Math.min(3600, Math.max(60, Number(durationSeconds) || 300));
        const response = await this.youtube.liveChatBans.insert({
            auth: this.auth,
            part: ['snippet'],
            resource: {
                snippet: {
                    liveChatId: chatId,
                    type: 'temporary',
                    banDurationSeconds: sec,
                    bannedUserDetails: {
                        channelId: bannedChannelId
                    }
                }
            }
        });
        console.log(`Live chat timeout applied (${sec}s) for ${bannedChannelId}`);
        return response.data;
    }
    async permanentlyBanLiveChatUser(bannedChannelId, liveChatId = null) {
        await this.tokenManager.ensureValidTokens();
        const chatId = liveChatId || this.liveChatId;
        if (!chatId)
            throw new Error('No active live chat ID available');
        if (!bannedChannelId)
            throw new Error('No user channel ID to ban');
        const response = await this.youtube.liveChatBans.insert({
            auth: this.auth,
            part: ['snippet'],
            resource: {
                snippet: {
                    liveChatId: chatId,
                    type: 'permanent',
                    bannedUserDetails: {
                        channelId: bannedChannelId
                    }
                }
            }
        });
        console.log(`Live chat permanent ban applied for ${bannedChannelId}`);
        return response.data;
    }
    async getChannelInfo() {
        try {
            await this.tokenManager.ensureValidTokens();
            const response = await this.youtube.channels.list({
                auth: this.auth,
                part: ['snippet', 'statistics', 'contentDetails'],
                mine: true
            });
            const channel = response.data.items?.[0];
            if (!channel?.snippet || !channel.statistics)
                throw new Error('Malformed channel payload');
            return {
                id: channel.id,
                title: channel.snippet.title,
                description: channel.snippet.description,
                thumbnails: channel.snippet.thumbnails,
                subscriberCount: channel.statistics.subscriberCount ?? undefined,
                viewCount: channel.statistics.viewCount ?? undefined,
                videoCount: channel.statistics.videoCount ?? undefined
            };
        }
        catch (error) {
            console.error('Failed to get channel info:', errMsg(error));
            throw error;
        }
    }
    async getLiveBroadcasts() {
        try {
            await this.tokenManager.ensureValidTokens();
            const response = await this.youtube.liveBroadcasts.list({
                auth: this.auth,
                part: ['snippet', 'status', 'contentDetails'],
                mine: true,
                maxResults: 10
            });
            return (response.data.items ?? []).map((broadcast) => ({
                id: broadcast.id,
                title: broadcast.snippet?.title,
                description: broadcast.snippet?.description,
                scheduledStartTime: broadcast.snippet?.scheduledStartTime,
                actualStartTime: broadcast.snippet?.actualStartTime,
                actualEndTime: broadcast.snippet?.actualEndTime,
                lifeCycleStatus: broadcast.status?.lifeCycleStatus,
                privacyStatus: broadcast.status?.privacyStatus,
                liveChatId: broadcast.snippet?.liveChatId
            }));
        }
        catch (error) {
            console.error('Failed to get broadcasts:', errMsg(error));
            throw error;
        }
    }
    async testConnection() {
        try {
            await this.tokenManager.ensureValidTokens();
            const channelResponse = await this.youtube.channels.list({
                auth: this.auth,
                part: ['snippet'],
                mine: true
            });
            if (!channelResponse.data.items ||
                channelResponse.data.items.length === 0) {
                throw new Error('No channel found for authenticated user');
            }
            const channel = channelResponse.data.items[0];
            return {
                success: true,
                channel: {
                    id: channel?.id,
                    title: channel?.snippet?.title,
                    thumbnails: channel?.snippet?.thumbnails
                },
                permissions: {
                    read: true,
                    write: true
                }
            };
        }
        catch (error) {
            return {
                success: false,
                error: errMsg(error),
                permissions: {
                    read: false,
                    write: false
                }
            };
        }
    }
    async getTokenStatus() {
        try {
            await this.tokenManager.ensureValidTokens();
            return {
                status: 'valid',
                message: 'YouTube API tokens are valid and ready'
            };
        }
        catch (error) {
            return {
                status: 'invalid',
                message: errMsg(error)
            };
        }
    }
    isOAuthConfigured() {
        return !!(this.config.get('youtube.clientId') &&
            this.config.get('youtube.clientSecret'));
    }
    async getAuthStatus() {
        if (!this.isOAuthConfigured()) {
            return {
                authenticated: false,
                oauthConfigured: false,
                reason: 'oauth_missing',
                message: 'Open System: paste your Google OAuth Client ID and secret (YouTube Data API), then pick Gemini or LM Studio for AI.'
            };
        }
        try {
            await this.tokenManager.ensureValidTokens();
            let channel = null;
            try {
                channel = await this.getChannelInfo();
            }
            catch (e) {
                console.warn('Channel info after auth:', errMsg(e));
            }
            return {
                authenticated: true,
                oauthConfigured: true,
                reason: 'ok',
                channel: channel
                    ? {
                        id: channel.id,
                        title: channel.title,
                        thumbnails: channel.thumbnails
                    }
                    : null
            };
        }
        catch (e) {
            const ce = e;
            const stored = await this.tokenManager.loadStoredTokens().catch(() => null);
            let reason;
            if (ce.code === 'NEEDS_REAUTH')
                reason = 'needs_reauth';
            else if (ce.code === 'REFRESH_FAILED')
                reason = 'refresh_failed';
            else if (!stored)
                reason = 'never_signed_in';
            else
                reason = 'needs_reauth';
            return {
                authenticated: false,
                oauthConfigured: true,
                needsSignIn: true,
                reason,
                message: ce.message
            };
        }
    }
    async signOut() {
        await this.tokenManager.clearTokens();
        return { success: true };
    }
    async refreshTokens() {
        try {
            await this.tokenManager.refreshTokens();
            return {
                status: 'success',
                message: 'Tokens refreshed successfully'
            };
        }
        catch (error) {
            return {
                status: 'error',
                message: errMsg(error)
            };
        }
    }
}
exports.default = YouTubeService;
/**
 * OAuth tokens keyed in SecretStore when available.
 */
const SECRET_TOKENS_KEY = 'youtube.tokens';
class TokenManager {
    auth;
    tokenPath;
    secretStore;
    _migrated = false;
    constructor(auth, tokenPath, secretStore) {
        this.auth = auth;
        this.tokenPath = tokenPath;
        this.secretStore = secretStore ?? null;
        this.setupTokenListener();
    }
    setupTokenListener() {
        this.auth.on('tokens', async (tokens) => {
            try {
                if (tokens.refresh_token) {
                    console.log('New refresh token received, updating stored tokens');
                    await this.saveTokens(tokens);
                }
                else {
                    const existingTokens = await this.loadStoredTokens();
                    if (existingTokens) {
                        const updatedTokens = { ...existingTokens, ...tokens };
                        await this.saveTokens(updatedTokens);
                    }
                }
                console.log('Access token updated successfully');
            }
            catch (error) {
                console.error('Error handling token update:', errMsg(error));
            }
        });
    }
    async _migrateFromTokenFileIfNeeded() {
        if (this._migrated || !this.secretStore)
            return;
        this._migrated = true;
        if (this.secretStore.has(SECRET_TOKENS_KEY))
            return;
        try {
            const readFile = util_1.default.promisify(fs_1.default.readFile);
            const buf = await readFile(this.tokenPath);
            const parsed = JSON.parse(buf.toString('utf8'));
            if (parsed && typeof parsed === 'object') {
                this.secretStore.set(SECRET_TOKENS_KEY, parsed);
                await this.secretStore.save();
                try {
                    await util_1.default.promisify(fs_1.default.unlink)(this.tokenPath);
                }
                catch {
                    /* ignore */
                }
                console.log('Migrated YouTube OAuth tokens from tokens.json into SecretStore.');
            }
        }
        catch {
            /* fine */
        }
    }
    async saveTokens(tokens) {
        if (this.secretStore) {
            this.secretStore.set(SECRET_TOKENS_KEY, tokens);
            await this.secretStore.save();
            return;
        }
        const writeFile = util_1.default.promisify(fs_1.default.writeFile);
        const mkdir = util_1.default.promisify(fs_1.default.mkdir);
        await mkdir(path_1.default.dirname(this.tokenPath), { recursive: true });
        await writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), {
            mode: 0o600
        });
    }
    async loadStoredTokens() {
        if (this.secretStore) {
            await this._migrateFromTokenFileIfNeeded();
            const t = this.secretStore.get(SECRET_TOKENS_KEY);
            return t || null;
        }
        try {
            const readFile = util_1.default.promisify(fs_1.default.readFile);
            const fileContents = await readFile(this.tokenPath);
            return JSON.parse(fileContents.toString());
        }
        catch {
            return null;
        }
    }
    async clearTokens() {
        try {
            this.auth.setCredentials({});
        }
        catch {
            /* ignore */
        }
        if (this.secretStore) {
            this.secretStore.delete(SECRET_TOKENS_KEY);
            try {
                await this.secretStore.save();
            }
            catch (e) {
                console.warn('SecretStore clear failed:', errMsg(e));
            }
        }
        try {
            await util_1.default.promisify(fs_1.default.unlink)(this.tokenPath);
        }
        catch {
            /* fine */
        }
    }
    isTokenExpired(tokens) {
        const exp = tokens.expiry_date;
        if (exp === undefined || exp === null)
            return false;
        const now = Date.now();
        const expiryMs = typeof exp === 'number' ? exp : Number(exp);
        const bufferTime = 5 * 60 * 1000;
        return expiryMs - bufferTime <= now;
    }
    async ensureValidTokens() {
        try {
            const tokens = await this.loadStoredTokens();
            if (!tokens) {
                throw new Error('No tokens found. Please authorize the application first.');
            }
            if (!tokens.refresh_token) {
                throw new Error('No refresh token found. Please re-authorize the application.');
            }
            if (this.isTokenExpired(tokens)) {
                console.log('Token expired, refreshing automatically...');
                await this.refreshTokens();
            }
            else {
                this.auth.setCredentials(tokens);
                console.log('Using valid existing tokens');
            }
            return true;
        }
        catch (error) {
            console.error('Token validation failed:', errMsg(error));
            throw error;
        }
    }
    async refreshTokens() {
        try {
            const existing = await this.loadStoredTokens();
            if (!existing?.refresh_token) {
                const e = new Error('No Google refresh token saved. Please sign in with Google.');
                e.code = 'NEEDS_REAUTH';
                throw e;
            }
            this.auth.setCredentials(existing);
            const { credentials } = await this.auth.refreshAccessToken();
            const merged = { ...existing, ...credentials };
            if (!merged.refresh_token && existing.refresh_token) {
                merged.refresh_token = existing.refresh_token;
            }
            this.auth.setCredentials(merged);
            await this.saveTokens(merged);
            console.log('Tokens refreshed successfully');
            return merged;
        }
        catch (error) {
            const g = asGaxios(error);
            const detail = String(g.response?.data?.error ||
                g.response?.data?.error_description ||
                g.message ||
                '').toLowerCase();
            const permanent = detail.includes('invalid_grant') ||
                detail.includes('invalid_client') ||
                detail.includes('unauthorized') ||
                detail.includes('token has been expired or revoked') ||
                g.response?.status === 400 ||
                g.response?.status === 401;
            if (permanent) {
                try {
                    await this.clearTokens();
                }
                catch {
                    /* ignore */
                }
                const e = new Error('Your Google sign-in expired or was revoked. Please sign in with Google again.');
                e.code = 'NEEDS_REAUTH';
                throw e;
            }
            console.error('Failed to refresh tokens:', errMsg(error));
            const e = new Error('Could not refresh Google sign-in. Check your network and try again.');
            e.code = 'REFRESH_FAILED';
            throw e;
        }
    }
}
//# sourceMappingURL=auth.js.map