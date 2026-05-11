/**
 * YouTube OAuth + Data API helpers.
 *
 * googleapis typings are intentionally loose here (`@ts-nocheck`) because the
 * generated client overloads churn between releases while runtime params stay stable.
 */
// @ts-nocheck

import { google } from 'googleapis';
import util from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import type { Credentials } from 'google-auth-library';

import type ConfigManager from '../config/ConfigManager';
import type SecretStore from '../config/SecretStore';

dotenv.config();

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

type CodedError = Error & { code?: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface LiveChatMessageListData {
  items?: unknown[];
  nextPageToken?: string | null;
  pollingIntervalMillis?: number | null;
}

interface GaxiosLike {
  response?: {
    status?: number;
    data?: { error?: string; error_description?: string };
  };
  message?: string;
}

function asGaxios(e: unknown): GaxiosLike {
  return e != null && typeof e === 'object' ? (e as GaxiosLike) : {};
}

/**
 * Extract YouTube video ID from a watch URL or raw id string.
 */
function extractYouTubeVideoId(input: unknown): string | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s, 'https://youtube.com');
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return id && id.length === 11 ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && v.length === 11) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    const liveIdx = parts.indexOf('live');
    if (
      liveIdx >= 0 &&
      parts[liveIdx + 1] &&
      parts[liveIdx + 1]!.length === 11
    ) {
      return parts[liveIdx + 1]!;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * YouTube Service with token management and error handling
 */
export default class YouTubeService {
  readonly config: ConfigManager;
  readonly youtube = google.youtube('v3');
  auth!: OAuth2Client;
  private readonly _pkcePending = new Map<
    string,
    { codeVerifier: string; t: number }
  >();

  readonly tokenPath: string;
  tokenManager!: TokenManager;

  /** Current live chat API id once resolved */
  liveChatId: string | null = null;

  constructor(config: ConfigManager) {
    this.config = config;
    this.auth = new google.auth.OAuth2(
      String(this.config.get('youtube.clientId') ?? ''),
      String(this.config.get('youtube.clientSecret') ?? ''),
      String(this.config.get('youtube.redirectUri') ?? '')
    );

    this.tokenPath =
      process.env.SAFESTREAM_TOKEN_PATH ||
      process.env.YTCHATGUARD_TOKEN_PATH ||
      path.join(process.cwd(), 'src', 'tokens.json');

    this.tokenManager = new TokenManager(
      this.auth,
      this.tokenPath,
      config.secrets
    );

    console.log('YouTube Service initialized');
  }

  /**
   * Recreate the OAuth2 client from current config (needed after HTTP port fallback updates `youtube.redirectUri`).
   */
  async rebindOAuthClientFromConfig(): Promise<void> {
    const stored = await this.tokenManager.loadStoredTokens().catch(() => null);
    this.auth = new google.auth.OAuth2(
      String(this.config.get('youtube.clientId') ?? ''),
      String(this.config.get('youtube.clientSecret') ?? ''),
      String(this.config.get('youtube.redirectUri') ?? '')
    );
    this.tokenManager = new TokenManager(
      this.auth,
      this.tokenPath,
      this.config.secrets
    );
    if (stored && Object.keys(stored).length > 0) {
      this.auth.setCredentials(stored);
    }
  }

  private _prunePkceStore(): void {
    const ttl = 15 * 60 * 1000;
    const now = Date.now();
    for (const [k, v] of this._pkcePending.entries()) {
      if (now - v.t > ttl) this._pkcePending.delete(k);
    }
  }

  /**
   * Generate OAuth2 authorization URL (PKCE + state; required for secure local redirect)
   */
  async getAuthUrl(): Promise<string> {
    this._prunePkceStore();
    const { codeVerifier, codeChallenge } =
      await this.auth.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString('base64url');
    this._pkcePending.set(state, { codeVerifier, t: Date.now() });
    const PKCE_MAX = 100;
    while (this._pkcePending.size > PKCE_MAX) {
      const oldest = this._pkcePending.keys().next().value as string | undefined;
      if (oldest) this._pkcePending.delete(oldest);
    }
    const scopesRaw = this.config.get('youtube.scopes');
    const scope =
      Array.isArray(scopesRaw)
        ? (scopesRaw.map(String) as string[])
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
  async exchangeCodeForTokens(
    code: string | undefined,
    state: string | undefined
  ): Promise<Credentials> {
    try {
      let tokenOpts: { code: string; codeVerifier?: string } = { code: code ?? '' };
      if (state) {
        const pending = this._pkcePending.get(state);
        if (!pending) {
          throw new Error(
            'Sign-in session expired or invalid. Click “Sign in with Google” again.'
          );
        }
        this._pkcePending.delete(state);
        tokenOpts = { code: code ?? '', codeVerifier: pending.codeVerifier };
      }

      const { tokens } = await this.auth.getToken(tokenOpts);

      this.auth.setCredentials(tokens);
      await this.tokenManager.saveTokens(tokens ?? {});

      console.log('Authorization successful, tokens saved');
      return tokens ?? {};
    } catch (error: unknown) {
      console.error('Failed to exchange code for tokens:', errMsg(error));
      throw new Error(`Authorization failed: ${errMsg(error)}`);
    }
  }

  /**
   * OAuth redirect handler (Express)
   */
  async handleCallback(
    code: string | string[] | undefined,
    state: string | string[] | undefined
  ): Promise<boolean> {
    const c = Array.isArray(code) ? code[0] : code;
    const st = Array.isArray(state) ? state[0] : state;
    if (!c) {
      throw new Error('Missing authorization code');
    }
    if (!st) {
      throw new Error(
        'Missing OAuth state. Start sign-in from this app again.'
      );
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
  async findLiveChatForVideo(videoIdOrUrl: string): Promise<string | null> {
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
  async initializeTokens(): Promise<boolean> {
    try {
      const success = await this.tokenManager.ensureValidTokens();
      if (success) {
        console.log('YouTube tokens initialized successfully');
      }
      return success;
    } catch (error: unknown) {
      console.log('YouTube tokens not available:', errMsg(error));
      return false;
    }
  }

  /**
   * Find active live chat ID
   */
  async findActiveChat(): Promise<string | null> {
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
    } catch (error: unknown) {
      console.error('Error finding active chat:', errMsg(error));
      const code = asGaxios(error).response?.status;
      const errCode =
        typeof (error as { code?: number }).code === 'number'
          ? (error as { code?: number }).code
          : code;
      if (errCode === 401) {
        console.log('Authentication expired, please re-authorize');
      } else if (errCode === 403) {
        console.log('Insufficient permissions or quota exceeded');
      }
      throw error;
    }
  }

  /**
   * Get live chat messages
   */
  async getChatMessages(
    liveChatId: string | null | undefined,
    pageToken: string | null = null
  ): Promise<LiveChatMessageListData> {
    try {
      await this.tokenManager.ensureValidTokens();

      const response = await this.youtube.liveChatMessages.list({
        auth: this.auth,
        part: ['snippet', 'authorDetails'],
        liveChatId: liveChatId || this.liveChatId || '',
        pageToken: pageToken ?? undefined,
        maxResults: 200
      });

      return response.data as LiveChatMessageListData;
    } catch (error: unknown) {
      const status = asGaxios(error).response?.status;
      const numCode = (error as { code?: number }).code;
      if (status === 404 || numCode === 404) {
        console.log('Live chat ended or not found');
        this.liveChatId = null;
      } else if (status === 401 || numCode === 401) {
        console.log('Authentication expired during message fetch');
        await this.tokenManager.refreshTokens();
      }

      throw error;
    }
  }

  /**
   * Send message to live chat
   */
  async sendMessage(
    messageText: string,
    liveChatId: string | null = null
  ): Promise<unknown> {
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
    } catch (error: unknown) {
      console.error('Failed to send message:', errMsg(error));
      const stat = asGaxios(error).response?.status;
      if (stat === 401) {
        console.log('Authentication expired during message send');
      } else if (stat === 403) {
        console.log('Insufficient permissions to send messages');
      } else if (stat === 400) {
        console.log('Invalid message format or chat not available');
      }

      throw error;
    }
  }

  async timeoutLiveChatUser(
    bannedChannelId: string | undefined,
    liveChatId: string | null = null,
    durationSeconds = 300
  ): Promise<unknown> {
    await this.tokenManager.ensureValidTokens();
    const chatId = liveChatId || this.liveChatId;
    if (!chatId) throw new Error('No active live chat ID available');
    if (!bannedChannelId) throw new Error('No user channel ID to timeout');

    const sec = Math.min(
      3600,
      Math.max(60, Number(durationSeconds) || 300)
    );

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

  async permanentlyBanLiveChatUser(
    bannedChannelId: string | undefined,
    liveChatId: string | null = null
  ): Promise<unknown> {
    await this.tokenManager.ensureValidTokens();
    const chatId = liveChatId || this.liveChatId;
    if (!chatId) throw new Error('No active live chat ID available');
    if (!bannedChannelId) throw new Error('No user channel ID to ban');

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

  async getChannelInfo(): Promise<{
    id: string | null | undefined;
    title: string | null | undefined;
    description: string | null | undefined;
    thumbnails: Record<string, unknown> | undefined;
    subscriberCount: string | null | undefined;
    viewCount: string | null | undefined;
    videoCount: string | null | undefined;
  }> {
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
        thumbnails: channel.snippet.thumbnails as Record<string, unknown>,
        subscriberCount: channel.statistics.subscriberCount ?? undefined,
        viewCount: channel.statistics.viewCount ?? undefined,
        videoCount: channel.statistics.videoCount ?? undefined
      };
    } catch (error: unknown) {
      console.error('Failed to get channel info:', errMsg(error));
      throw error;
    }
  }

  async getLiveBroadcasts(): Promise<
    Array<{
      id: string | undefined;
      title: string | undefined;
      description: string | undefined;
      scheduledStartTime: string | null | undefined;
      actualStartTime: string | null | undefined;
      actualEndTime: string | null | undefined;
      lifeCycleStatus: string | undefined;
      privacyStatus: string | undefined;
      liveChatId: string | null | undefined;
    }>
  > {
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
    } catch (error: unknown) {
      console.error('Failed to get broadcasts:', errMsg(error));
      throw error;
    }
  }

  async testConnection(): Promise<{
    success: boolean;
    error?: string;
    channel?: { id: unknown; title: unknown; thumbnails: unknown };
    permissions: { read: boolean; write: boolean };
  }> {
    try {
      await this.tokenManager.ensureValidTokens();

      const channelResponse = await this.youtube.channels.list({
        auth: this.auth,
        part: ['snippet'],
        mine: true
      });

      if (
        !channelResponse.data.items ||
        channelResponse.data.items.length === 0
      ) {
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
    } catch (error: unknown) {
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

  async getTokenStatus(): Promise<{ status: string; message: string }> {
    try {
      await this.tokenManager.ensureValidTokens();
      return {
        status: 'valid',
        message: 'YouTube API tokens are valid and ready'
      };
    } catch (error: unknown) {
      return {
        status: 'invalid',
        message: errMsg(error)
      };
    }
  }

  isOAuthConfigured(): boolean {
    return !!(
      this.config.get('youtube.clientId') &&
      this.config.get('youtube.clientSecret')
    );
  }

  async getAuthStatus(): Promise<Record<string, unknown>> {
    if (!this.isOAuthConfigured()) {
      return {
        authenticated: false,
        oauthConfigured: false,
        reason: 'oauth_missing',
        message:
          'Open System: paste your Google OAuth Client ID and secret (YouTube Data API), then pick Gemini or LM Studio for AI.'
      };
    }
    try {
      await this.tokenManager.ensureValidTokens();
      let channel: Awaited<ReturnType<YouTubeService['getChannelInfo']>> | null =
        null;
      try {
        channel = await this.getChannelInfo();
      } catch (e: unknown) {
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
    } catch (e: unknown) {
      const ce = e as CodedError;
      const stored = await this.tokenManager.loadStoredTokens().catch(() => null);
      let reason: string;
      if (ce.code === 'NEEDS_REAUTH') reason = 'needs_reauth';
      else if (ce.code === 'REFRESH_FAILED') reason = 'refresh_failed';
      else if (!stored) reason = 'never_signed_in';
      else reason = 'needs_reauth';
      return {
        authenticated: false,
        oauthConfigured: true,
        needsSignIn: true,
        reason,
        message: ce.message
      };
    }
  }

  async signOut(): Promise<{ success: boolean }> {
    await this.tokenManager.clearTokens();
    return { success: true };
  }

  async refreshTokens(): Promise<{
    status: string;
    message: string;
  }> {
    try {
      await this.tokenManager.refreshTokens();
      return {
        status: 'success',
        message: 'Tokens refreshed successfully'
      };
    } catch (error: unknown) {
      return {
        status: 'error',
        message: errMsg(error)
      };
    }
  }
}

/**
 * OAuth tokens keyed in SecretStore when available.
 */
const SECRET_TOKENS_KEY = 'youtube.tokens';

class TokenManager {
  readonly auth: OAuth2Client;
  readonly tokenPath: string;
  readonly secretStore: SecretStore | null;
  private _migrated = false;

  constructor(
    auth: OAuth2Client,
    tokenPath: string,
    secretStore: SecretStore | null | undefined
  ) {
    this.auth = auth;
    this.tokenPath = tokenPath;
    this.secretStore = secretStore ?? null;
    this.setupTokenListener();
  }

  setupTokenListener(): void {
    this.auth.on('tokens', async (tokens) => {
      try {
        if (tokens.refresh_token) {
          console.log('New refresh token received, updating stored tokens');
          await this.saveTokens(tokens);
        } else {
          const existingTokens = await this.loadStoredTokens();
          if (existingTokens) {
            const updatedTokens = { ...existingTokens, ...tokens };
            await this.saveTokens(updatedTokens);
          }
        }
        console.log('Access token updated successfully');
      } catch (error: unknown) {
        console.error('Error handling token update:', errMsg(error));
      }
    });
  }

  async _migrateFromTokenFileIfNeeded(): Promise<void> {
    if (this._migrated || !this.secretStore) return;
    this._migrated = true;
    if (this.secretStore.has(SECRET_TOKENS_KEY)) return;
    try {
      const readFile = util.promisify(fs.readFile);
      const buf = await readFile(this.tokenPath);
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        this.secretStore.set(SECRET_TOKENS_KEY, parsed);
        await this.secretStore.save();
        try {
          await util.promisify(fs.unlink)(this.tokenPath);
        } catch {
          /* ignore */
        }
        console.log(
          'Migrated YouTube OAuth tokens from tokens.json into SecretStore.'
        );
      }
    } catch {
      /* fine */
    }
  }

  async saveTokens(tokens: Credentials): Promise<void> {
    if (this.secretStore) {
      this.secretStore.set(SECRET_TOKENS_KEY, tokens);
      await this.secretStore.save();
      return;
    }
    const writeFile = util.promisify(fs.writeFile);
    const mkdir = util.promisify(fs.mkdir);
    await mkdir(path.dirname(this.tokenPath), { recursive: true });
    await writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), {
      mode: 0o600
    });
  }

  async loadStoredTokens(): Promise<Credentials | null> {
    if (this.secretStore) {
      await this._migrateFromTokenFileIfNeeded();
      const t = this.secretStore.get(SECRET_TOKENS_KEY);
      return (t as Credentials) || null;
    }
    try {
      const readFile = util.promisify(fs.readFile);
      const fileContents = await readFile(this.tokenPath);
      return JSON.parse(fileContents.toString()) as Credentials;
    } catch {
      return null;
    }
  }

  async clearTokens(): Promise<void> {
    try {
      this.auth.setCredentials({});
    } catch {
      /* ignore */
    }
    if (this.secretStore) {
      this.secretStore.delete(SECRET_TOKENS_KEY);
      try {
        await this.secretStore.save();
      } catch (e: unknown) {
        console.warn('SecretStore clear failed:', errMsg(e));
      }
    }
    try {
      await util.promisify(fs.unlink)(this.tokenPath);
    } catch {
      /* fine */
    }
  }

  isTokenExpired(tokens: Credentials): boolean {
    const exp = tokens.expiry_date as number | undefined;
    if (exp === undefined || exp === null) return false;
    const now = Date.now();
    const expiryMs = typeof exp === 'number' ? exp : Number(exp);
    const bufferTime = 5 * 60 * 1000;
    return expiryMs - bufferTime <= now;
  }

  async ensureValidTokens(): Promise<boolean> {
    try {
      const tokens = await this.loadStoredTokens();

      if (!tokens) {
        throw new Error(
          'No tokens found. Please authorize the application first.'
        );
      }

      if (!tokens.refresh_token) {
        throw new Error(
          'No refresh token found. Please re-authorize the application.'
        );
      }

      if (this.isTokenExpired(tokens)) {
        console.log('Token expired, refreshing automatically...');
        await this.refreshTokens();
      } else {
        this.auth.setCredentials(tokens);
        console.log('Using valid existing tokens');
      }

      return true;
    } catch (error: unknown) {
      console.error('Token validation failed:', errMsg(error));
      throw error;
    }
  }

  async refreshTokens(): Promise<Credentials> {
    try {
      const existing = await this.loadStoredTokens();
      if (!existing?.refresh_token) {
        const e = new Error(
          'No Google refresh token saved. Please sign in with Google.'
        ) as CodedError;
        e.code = 'NEEDS_REAUTH';
        throw e;
      }
      this.auth.setCredentials(existing);
      const { credentials } = await this.auth.refreshAccessToken();
      const merged: Credentials = { ...existing, ...credentials };
      if (!merged.refresh_token && existing.refresh_token) {
        merged.refresh_token = existing.refresh_token;
      }
      this.auth.setCredentials(merged);
      await this.saveTokens(merged);
      console.log('Tokens refreshed successfully');
      return merged;
    } catch (error: unknown) {
      const g = asGaxios(error);
      const detail = String(
        g.response?.data?.error ||
          g.response?.data?.error_description ||
          g.message ||
          ''
      ).toLowerCase();

      const permanent =
        detail.includes('invalid_grant') ||
        detail.includes('invalid_client') ||
        detail.includes('unauthorized') ||
        detail.includes('token has been expired or revoked') ||
        g.response?.status === 400 ||
        g.response?.status === 401;

      if (permanent) {
        try {
          await this.clearTokens();
        } catch {
          /* ignore */
        }
        const e = new Error(
          'Your Google sign-in expired or was revoked. Please sign in with Google again.'
        ) as CodedError;
        e.code = 'NEEDS_REAUTH';
        throw e;
      }
      console.error('Failed to refresh tokens:', errMsg(error));
      const e = new Error(
        'Could not refresh Google sign-in. Check your network and try again.'
      ) as CodedError;
      e.code = 'REFRESH_FAILED';
      throw e;
    }
  }
}
