const { google } = require('googleapis');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

/**
 * Extract YouTube video ID from a watch URL or raw id string.
 */
function extractYouTubeVideoId(input) {
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
    if (liveIdx >= 0 && parts[liveIdx + 1] && parts[liveIdx + 1].length === 11) {
      return parts[liveIdx + 1];
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * YouTube Service with token management and error handling
 */
class YouTubeService {
  constructor(config) {
    this.config = config;
    this.youtube = google.youtube('v3');
    this.OAuth2 = google.auth.OAuth2;
    
    // Initialize OAuth2 client (Desktop clients may use PKCE; secret can be empty string in some setups)
    this.auth = new this.OAuth2(
      this.config.get('youtube.clientId'),
      this.config.get('youtube.clientSecret') || '',
      this.config.get('youtube.redirectUri')
    );

    /** @type {Map<string, { codeVerifier: string, t: number }>} */
    this._pkcePending = new Map();

    this.tokenPath =
      process.env.YTCHATGUARD_TOKEN_PATH ||
      path.join(process.cwd(), 'src', 'tokens.json');
    this.tokenManager = new TokenManager(this.auth, this.tokenPath);
    
    // Current live chat state
    this.liveChatId = null;
    
    console.log('🎥 YouTube Service initialized');
  }

  _prunePkceStore() {
    const ttl = 15 * 60 * 1000;
    const now = Date.now();
    for (const [k, v] of this._pkcePending.entries()) {
      if (now - v.t > ttl) this._pkcePending.delete(k);
    }
  }

  /**
   * Generate OAuth2 authorization URL (PKCE + state; required for secure local redirect)
   */
  async getAuthUrl() {
    this._prunePkceStore();
    const { codeVerifier, codeChallenge } =
      await this.auth.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString('base64url');
    this._pkcePending.set(state, { codeVerifier, t: Date.now() });
    return this.auth.generateAuthUrl({
      access_type: 'offline',
      scope: this.config.get('youtube.scopes'),
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
      let tokenOpts = { code };
      if (state) {
        const pending = this._pkcePending.get(state);
        if (!pending) {
          throw new Error(
            'Sign-in session expired or invalid. Click “Sign in with Google” again.'
          );
        }
        this._pkcePending.delete(state);
        tokenOpts = { code, codeVerifier: pending.codeVerifier };
      }

      const { tokens } = await this.auth.getToken(tokenOpts);

      this.auth.setCredentials(tokens);
      await this.tokenManager.saveTokens(tokens);

      console.log('✅ Authorization successful, tokens saved');
      return tokens;
    } catch (error) {
      console.error('❌ Failed to exchange code for tokens:', error.message);
      throw new Error(`Authorization failed: ${error.message}`);
    }
  }

  /**
   * OAuth redirect handler (Express)
   */
  async handleCallback(code, state) {
    if (!code) {
      throw new Error('Missing authorization code');
    }
    if (!state) {
      throw new Error('Missing OAuth state. Start sign-in from this app again.');
    }
    await this.exchangeCodeForTokens(code, state);
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

    const item = response.data.items && response.data.items[0];
    const chatId = item?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) {
      console.log('⚠️  No active live chat for video (is the stream live?)');
      return null;
    }

    this.liveChatId = chatId;
    const title = item?.snippet?.title || videoId;
    console.log(`✅ Live chat for video ${videoId}: ${chatId} (${title})`);
    return chatId;
  }

  /**
   * Load and validate stored tokens
   */
  async initializeTokens() {
    try {
      const success = await this.tokenManager.ensureValidTokens();
      if (success) {
        console.log('✅ YouTube tokens initialized successfully');
      }
      return success;
    } catch (error) {
      console.log('⚠️  YouTube tokens not available:', error.message);
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
        part: 'snippet,contentDetails',
        mine: true,
        broadcastStatus: 'active'
      });
      
      const broadcasts = response.data.items;
      
      if (!broadcasts || broadcasts.length === 0) {
        console.log('⚠️  No active live broadcasts found');
        return null;
      }

      // Find broadcast with live chat
      for (const broadcast of broadcasts) {
        if (broadcast.snippet.liveChatId) {
          this.liveChatId = broadcast.snippet.liveChatId;
          console.log(`✅ Active live chat found: ${this.liveChatId}`);
          console.log(`📺 Broadcast: ${broadcast.snippet.title}`);
          return this.liveChatId;
        }
      }

      console.log('⚠️  No live broadcasts with chat found');
      return null;
      
    } catch (error) {
      console.error('❌ Error finding active chat:', error.message);
      
      if (error.code === 401) {
        console.log('🔑 Authentication expired, please re-authorize');
      } else if (error.code === 403) {
        console.log('🔒 Insufficient permissions or quota exceeded');
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
        part: 'snippet,authorDetails',
        liveChatId: liveChatId || this.liveChatId,
        pageToken,
        maxResults: 200
      });
      
      return response.data;
      
    } catch (error) {
      if (error.code === 404) {
        console.log('📺 Live chat ended or not found');
        this.liveChatId = null;
      } else if (error.code === 401) {
        console.log('🔑 Authentication expired during message fetch');
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
        part: 'snippet',
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
      
      console.log('✅ Message sent successfully');
      return response.data;
      
    } catch (error) {
      console.error('❌ Failed to send message:', error.message);
      
      if (error.code === 401) {
        console.log('🔑 Authentication expired during message send');
      } else if (error.code === 403) {
        console.log('🔒 Insufficient permissions to send messages');
      } else if (error.code === 400) {
        console.log('📝 Invalid message format or chat not available');
      }
      
      throw error;
    }
  }

  /**
   * Temporary ban (timeout) a user in the active live chat via YouTube Data API.
   * Requires scope https://www.googleapis.com/auth/youtube (or force-ssl) and moderator permissions.
   * @param {string} bannedChannelId - Target user's channel ID (from live chat authorDetails.channelId)
   * @param {string} [liveChatId] - Defaults to current active chat
   * @param {number} [durationSeconds] - 60–3600
   */
  async timeoutLiveChatUser(bannedChannelId, liveChatId = null, durationSeconds = 300) {
    await this.tokenManager.ensureValidTokens();
    const chatId = liveChatId || this.liveChatId;
    if (!chatId) throw new Error('No active live chat ID available');
    if (!bannedChannelId) throw new Error('No user channel ID to timeout');

    const sec = Math.min(3600, Math.max(60, Number(durationSeconds) || 300));

    const response = await this.youtube.liveChatBans.insert({
      auth: this.auth,
      part: 'snippet',
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

    console.log(`✅ Live chat timeout applied (${sec}s) for ${bannedChannelId}`);
    return response.data;
  }

  /**
   * Permanently ban a user from the live chat (until stream ends / manual unban in YouTube).
   */
  async permanentlyBanLiveChatUser(bannedChannelId, liveChatId = null) {
    await this.tokenManager.ensureValidTokens();
    const chatId = liveChatId || this.liveChatId;
    if (!chatId) throw new Error('No active live chat ID available');
    if (!bannedChannelId) throw new Error('No user channel ID to ban');

    const response = await this.youtube.liveChatBans.insert({
      auth: this.auth,
      part: 'snippet',
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

    console.log(`✅ Live chat permanent ban applied for ${bannedChannelId}`);
    return response.data;
  }

  /**
   * Get channel information
   */
  async getChannelInfo() {
    try {
      await this.tokenManager.ensureValidTokens();
      
      const response = await this.youtube.channels.list({
        auth: this.auth,
        part: 'snippet,statistics,contentDetails',
        mine: true
      });
      
      const channel = response.data.items[0];
      
      return {
        id: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        thumbnails: channel.snippet.thumbnails,
        subscriberCount: channel.statistics.subscriberCount,
        viewCount: channel.statistics.viewCount,
        videoCount: channel.statistics.videoCount
      };
      
    } catch (error) {
      console.error('❌ Failed to get channel info:', error.message);
      throw error;
    }
  }

  /**
   * Get live broadcast details
   */
  async getLiveBroadcasts() {
    try {
      await this.tokenManager.ensureValidTokens();
      
      const response = await this.youtube.liveBroadcasts.list({
        auth: this.auth,
        part: 'snippet,status,contentDetails',
        mine: true,
        maxResults: 10
      });
      
      return response.data.items.map(broadcast => ({
        id: broadcast.id,
        title: broadcast.snippet.title,
        description: broadcast.snippet.description,
        scheduledStartTime: broadcast.snippet.scheduledStartTime,
        actualStartTime: broadcast.snippet.actualStartTime,
        actualEndTime: broadcast.snippet.actualEndTime,
        lifeCycleStatus: broadcast.status.lifeCycleStatus,
        privacyStatus: broadcast.status.privacyStatus,
        liveChatId: broadcast.snippet.liveChatId
      }));
      
    } catch (error) {
      console.error('❌ Failed to get broadcasts:', error.message);
      throw error;
    }
  }

  /**
   * Test API connection and permissions
   */
  async testConnection() {
    try {
      await this.tokenManager.ensureValidTokens();
      
      // Test basic API access
      const channelResponse = await this.youtube.channels.list({
        auth: this.auth,
        part: 'snippet',
        mine: true
      });
      
      if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
        throw new Error('No channel found for authenticated user');
      }
      
      const channel = channelResponse.data.items[0];
      
      return {
        success: true,
        channel: {
          id: channel.id,
          title: channel.snippet.title,
          thumbnails: channel.snippet.thumbnails
        },
        permissions: {
          read: true,
          write: true // Assume write access if we got this far
        }
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        permissions: {
          read: false,
          write: false
        }
      };
    }
  }

  /**
   * Get token status
   */
  async getTokenStatus() {
    try {
      await this.tokenManager.ensureValidTokens();
      return {
        status: 'valid',
        message: 'YouTube API tokens are valid and ready'
      };
    } catch (error) {
      return {
        status: 'invalid',
        message: error.message
      };
    }
  }

  isOAuthConfigured() {
    return !!(
      this.config.get('youtube.clientId') && this.config.get('youtube.clientSecret')
    );
  }

  /**
   * For dashboard: whether Google sign-in completed and tokens work.
   */
  async getAuthStatus() {
    if (!this.isOAuthConfigured()) {
      return {
        authenticated: false,
        oauthConfigured: false,
        message:
          'Open System: paste your Google OAuth Client ID and secret (YouTube Data API), then pick Gemini or LM Studio for AI.'
      };
    }
    try {
      await this.tokenManager.ensureValidTokens();
      let channel = null;
      try {
        channel = await this.getChannelInfo();
      } catch (e) {
        console.warn('⚠️  Channel info after auth:', e.message);
      }
      return {
        authenticated: true,
        oauthConfigured: true,
        channel: channel
          ? { id: channel.id, title: channel.title, thumbnails: channel.thumbnails }
          : null
      };
    } catch (e) {
      return {
        authenticated: false,
        oauthConfigured: true,
        needsSignIn: true,
        message: e.message
      };
    }
  }

  /**
   * Refresh tokens manually
   */
  async refreshTokens() {
    try {
      await this.tokenManager.refreshTokens();
      return {
        status: 'success',
        message: 'Tokens refreshed successfully'
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message
      };
    }
  }
}

/**
 * Token Manager with automatic refresh
 */
class TokenManager {
  constructor(auth, tokenPath) {
    this.auth = auth;
    this.tokenPath = tokenPath;
    this.setupTokenListener();
  }

  setupTokenListener() {
    this.auth.on('tokens', async (tokens) => {
      try {
        if (tokens.refresh_token) {
          console.log('🔄 New refresh token received, updating stored tokens');
          await this.saveTokens(tokens);
        } else {
          // Update only access token if no refresh token
          const existingTokens = await this.loadStoredTokens();
          if (existingTokens) {
            const updatedTokens = { ...existingTokens, ...tokens };
            await this.saveTokens(updatedTokens);
          }
        }
        console.log('✅ Access token updated successfully');
      } catch (error) {
        console.error('❌ Error handling token update:', error.message);
      }
    });
  }

  async saveTokens(tokens) {
    const writeFile = util.promisify(fs.writeFile);
    const mkdir = util.promisify(fs.mkdir);
    await mkdir(path.dirname(this.tokenPath), { recursive: true });
    await writeFile(this.tokenPath, JSON.stringify(tokens, null, 2));
  }

  async loadStoredTokens() {
    try {
      const readFile = util.promisify(fs.readFile);
      const fileContents = await readFile(this.tokenPath);
      return JSON.parse(fileContents);
    } catch (error) {
      return null;
    }
  }

  isTokenExpired(tokens) {
    if (!tokens.expiry_date) return false;
    const now = Date.now();
    const expiry = new Date(tokens.expiry_date).getTime();
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    return expiry - bufferTime <= now;
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

      // Check if token needs refresh
      if (this.isTokenExpired(tokens)) {
        console.log('🔄 Token expired, refreshing automatically...');
        await this.refreshTokens();
      } else {
        this.auth.setCredentials(tokens);
        console.log('✅ Using valid existing tokens');
      }
      
      return true;
    } catch (error) {
      console.error('❌ Token validation failed:', error.message);
      throw error;
    }
  }

  async refreshTokens() {
    try {
      const existing = await this.loadStoredTokens();
      const { credentials } = await this.auth.refreshAccessToken();
      const merged = { ...existing, ...credentials };
      if (!merged.refresh_token && existing?.refresh_token) {
        merged.refresh_token = existing.refresh_token;
      }
      this.auth.setCredentials(merged);
      await this.saveTokens(merged);
      console.log('✅ Tokens refreshed successfully');
      return merged;
    } catch (error) {
      console.error('❌ Failed to refresh tokens:', error.message);
      throw new Error('Token refresh failed. Please re-authorize the application.');
    }
  }
}

module.exports = YouTubeService;