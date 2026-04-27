/**
 * SafeStream — AI-assisted YouTube live chat moderation
 * Intelligent AI-powered content analysis for YouTube live chat
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { assertSafeLocalUrl } = require('./src/config/UrlAllowlist');
const EventEmitter = require('events');
const axios = require('axios');

const MAX_API_LIMIT = 500;
const MAX_API_OFFSET = 5_000_000;

function parseApiInt(value, fallback, min, max) {
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Import services
const ConfigManager = require('./src/config/ConfigManager');
const YouTubeService = require('./src/features/auth');
const ChatMonitor = require('./src/services/ChatMonitor');
const AIService = require('./src/services/AIService');

/**
 * SafeStream — smart AI-powered live chat moderation
 * Records ALL messages + Uses AI smartly for optimal performance
 */
class SafeStream extends EventEmitter {
  constructor() {
    super();
    
    this.app = express();
    this.server = null;
    this.config = new ConfigManager();
    
    // Services
    this.youtubeService = null;
    this.smartMonitor = null;
    this.aiService = null;
    
    // State
    this.isMonitoring = false;
    this._listenPort = null;
    /** @type {string|null} Per-process secret for /api/* (set in _setupExpress). */
    this._apiToken = null;

    console.log('SafeStream initialized — AI moderation');
    console.log('Records every message | Uses AI intelligently');
  }

  /**
   * Initialize services and start server
   * @param {{ port?: number, electron?: boolean, oauthHost?: string }} [options]
   */
  async initialize(options = {}) {
    try {
      console.log('Initializing SafeStream…');
      console.log('Features: Complete message recording + intelligent AI usage');

      await this.config.load();

      this._applyRuntimeOptions(options);

      this._setupExpress();

      await this._initializeServices();

      const port =
        this.config.get('server.port') ||
        this.config.get('app.port') ||
        3000;

      await new Promise((resolve, reject) => {
        this.server = this.app.listen(port, '127.0.0.1', () => {
          const addr = this.server.address();
          this._listenPort =
            typeof addr === 'object' && addr ? addr.port : Number(port);
          const host =
            options.oauthHost ||
            (options.electron ? '127.0.0.1' : 'localhost');
          console.log(
            `SafeStream running on http://${host}:${this._listenPort}`
          );
          console.log(`Open http://127.0.0.1:${this._listenPort} for the interface`);
          resolve(true);
        });
        this.server.once('error', reject);
      });

      return true;
    } catch (error) {
      console.error('Failed to initialize Smart system:', error);
      throw error;
    }
  }

  /**
   * Electron / CLI: bind port and OAuth redirect before services start.
   */
  _applyRuntimeOptions(options) {
    if (options.port != null && !Number.isNaN(Number(options.port))) {
      const p = Number(options.port);
      this.config.set('server.port', p);
      this.config.set('app.port', p);
    }
    const host = options.oauthHost || '127.0.0.1';
    const listenPort =
      this.config.get('server.port') || this.config.get('app.port') || 3000;
    if (options.electron || options.port != null) {
      this.config.set(
        'youtube.redirectUri',
        `http://${host}:${listenPort}/auth/callback`
      );
    }
    if (options.electron) {
      this.config.set('app.electron', true);
    }
  }

  /** Port the HTTP server is listening on (after listen). */
  getListenPort() {
    return this._listenPort != null
      ? this._listenPort
      : this.config.get('server.port') || this.config.get('app.port') || 3000;
  }

  /** Secret required in `X-SafeStream-Token` (or `_ss_token` query for GET export links). */
  getApiToken() {
    return this._apiToken;
  }

  _isPublicHttpRoute(req) {
    const p = req.path || '';
    if (req.method === 'GET' && (p === '/' || p === '/health')) return true;
    if (req.method === 'GET' && (p.startsWith('/css/') || p.startsWith('/js/'))) {
      return true;
    }
    if (req.method === 'GET' && (p === '/login' || p === '/callback')) return true;
    if (req.method === 'GET' && p.startsWith('/auth/callback')) return true;
    return false;
  }

  _apiAuthMiddleware(req, res, next) {
    if (this._isPublicHttpRoute(req)) return next();
    let sent = req.headers['x-safestream-token'] || '';
    if (!sent && req.query && req.query._ss_token != null) {
      sent = req.query._ss_token;
    }
    if (Array.isArray(sent)) sent = sent[0] || '';
    sent = String(sent || '');
    if (sent && sent === this._apiToken) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  /**
   * Recreate YouTube OAuth client after saving new credentials from Settings UI.
   */
  recreateYoutubeService() {
    this.youtubeService = new YouTubeService(this.config);
    if (this.smartMonitor) {
      this.smartMonitor.youtubeService = this.youtubeService;
    }
  }

  /** Reload AI stack after settings change (provider / LM Studio URL / keys). */
  recreateAIService() {
    this.aiService = new AIService(this.config);
    if (this.smartMonitor) {
      this.smartMonitor.aiService = this.aiService;
    }
  }

  /**
   * Setup Express middleware and routes
   */
  _setupExpress() {
    this._apiToken = crypto.randomBytes(32).toString('base64url');
    this.app.disable('x-powered-by');
    this.app.set('trust proxy', false);
    this.app.use((req, res, next) => {
      const host = String(req.headers.host || '');
      const hostname = host.split(':')[0];
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
      if (!allowedHosts.has(hostname)) {
        return res.status(400).json({ error: 'Bad Host header' });
      }
      const origin = req.headers.origin;
      if (origin) {
        try {
          const u = new URL(origin);
          const okOrigin =
            u.hostname === '127.0.0.1' ||
            u.hostname === 'localhost' ||
            u.hostname === '::1';
          if (!okOrigin) {
            return res.status(403).json({ error: 'Origin not allowed' });
          }
        } catch {
          return res.status(400).json({ error: 'Bad Origin' });
        }
      }
      res.setHeader('Vary', 'Origin');
      next();
    });
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use((req, res, next) => this._apiAuthMiddleware(req, res, next));
    this.app.use(express.static(path.join(__dirname, 'src/public')));

    this._setupRoutes();
    this._setupDeveloperRoutes();
  }

  /**
   * Setup developer-friendly routes
   */
  _setupDeveloperRoutes() {


    // Debug information
    this.app.get('/api/debug', (req, res) => {
      res.json({
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage()
        },
        config: this.config.getAllConfig(),
        services: {
          youtubeService: !!this.youtubeService,
          aiService: !!this.aiService,
          smartMonitor: !!this.smartMonitor
        },
        monitoring: {
          isRunning: this.isMonitoring,
          videoId: this.smartMonitor?.currentVideoId || null,
          stats: this.smartMonitor ? this.smartMonitor.getSmartStats() : {}
        }
      });
    });

    // Raw message data with pagination
    this.app.get('/api/dev/messages/raw', (req, res) => {
      const page = parseApiInt(req.query.page, 1, 1, 1_000_000);
      const limit = parseApiInt(req.query.limit, 50, 1, 200);
      const offset = (page - 1) * limit;

      if (!this.smartMonitor?.messageDatabase) {
        return res.json({ messages: [], total: 0, page: 1, pages: 0 });
      }

      const total = this.smartMonitor.messageDatabase.length;
      const messages = this.smartMonitor.messageDatabase
        .slice(offset, offset + limit)
        .map(msg => ({
          ...msg,
          messagePreview: msg.message.substring(0, 100),
          wordCount: msg.message.split(' ').length
        }));

      res.json({
        messages,
        total,
        page,
        pages: Math.ceil(total / limit) || 0,
        showing: messages.length
      });
    });

    // Analysis breakdown
    this.app.get('/api/dev/analysis/breakdown', (req, res) => {
      if (!this.smartMonitor?.analysisDatabase) {
        return res.json({ breakdown: {}, total: 0 });
      }

      const analyses = this.smartMonitor.analysisDatabase;
      const breakdown = {
        byMethod: {},
        bySeverity: {},
        byViolationType: {},
        processingTimes: []
      };

      analyses.forEach(item => {
        const analysis = item.analysis;
        
        // By method
        const method = analysis.method || 'unknown';
        breakdown.byMethod[method] = (breakdown.byMethod[method] || 0) + 1;
        
        // By severity
        if (analysis.isViolation && analysis.severity) {
          breakdown.bySeverity[analysis.severity] = (breakdown.bySeverity[analysis.severity] || 0) + 1;
        }
        
        // Processing times
        if (analysis.processingTime) {
          breakdown.processingTimes.push(analysis.processingTime);
        }
      });

      // Calculate processing time stats
      if (breakdown.processingTimes.length > 0) {
        breakdown.processingTimes.sort((a, b) => a - b);
        breakdown.processingStats = {
          min: breakdown.processingTimes[0],
          max: breakdown.processingTimes[breakdown.processingTimes.length - 1],
          median: breakdown.processingTimes[Math.floor(breakdown.processingTimes.length / 2)],
          average: breakdown.processingTimes.reduce((a, b) => a + b, 0) / breakdown.processingTimes.length
        };
      }

      res.json({ breakdown, total: analyses.length });
    });

    // Export data
    this.app.get('/api/dev/export/:type', (req, res) => {
      const { type } = req.params;
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      
      try {
        let data, filename;
        
        switch (type) {
          case 'messages':
            data = this.smartMonitor?.messageDatabase || [];
            filename = `safestream-messages-${timestamp}.json`;
            break;
          case 'analysis':
            data = this.smartMonitor?.analysisDatabase || [];
            filename = `safestream-analysis-${timestamp}.json`;
            break;
          case 'users':
            data = Array.from(this.smartMonitor?.userProfiles?.values() || []);
            filename = `safestream-users-${timestamp}.json`;
            break;
          default:
            return res.status(400).json({ error: 'Invalid export type' });
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(data);
        
      } catch (error) {
        res.status(500).json({ error: 'Export failed: ' + error.message });
      }
    });

    // Test AI provider
    this.app.post('/api/dev/test-ai', async (req, res) => {
      const { message, provider } = req.body;
      
      try {
        const startTime = Date.now();
        const result = await this.aiService.analyzeMessage(
          message || 'This is a test message', 
          'TestUser',
          { provider: provider || 'auto', testMode: true }
        );
        result.responseTime = Date.now() - startTime;
        
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ error: error.message, success: false });
      }
    });

    console.log('Developer routes enabled: /dev, /api/debug, /api/dev/*');
  }

  /**
   * Setup API routes
   */
  _setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ready', 
        mode: 'smart-ai',
        version: '3.0.0',
        features: ['records_everything', 'smart_ai_usage', 'intelligent_caching', 'dev_tools']
      });
    });

    // Main interface — inject per-process API token for the dashboard script.
    this.app.get('/', async (req, res) => {
      try {
        const filePath = path.join(__dirname, 'src/public/dashboard.html');
        let html = await fs.readFile(filePath, 'utf8');
        const inject = `<script>window.__SAFESTREAM_API_TOKEN__=${JSON.stringify(this._apiToken)};<\/script>`;
        const marker = '<!-- SAFESTREAM_API_TOKEN_INJECT -->';
        html = html.includes(marker)
          ? html.replace(marker, inject)
          : inject + html;
        res.type('html').send(html);
      } catch (e) {
        res.status(500).type('text').send('Failed to load dashboard');
      }
    });

    // Smart statistics
    this.app.get('/api/smart-stats', (req, res) => {
      const stats = this.smartMonitor ? this.smartMonitor.getSmartStats() : {};
      res.json(stats);
    });

    // Recent comment buffer (used for SSE replay on (re)connect)
    this.app.get('/api/comments/recent', (req, res) => {
      if (!this.smartMonitor?.getRecentComments) return res.json({ comments: [] });
      const limit = parseApiInt(req.query.limit, 200, 1, 1000);
      res.json({ comments: this.smartMonitor.getRecentComments(limit) });
    });

    // Live event stream — pushes every comment, verdict, violation, and stats
    // change to the dashboard over SSE. Auth via `?_ss_token=` query param
    // because EventSource() can't set custom headers.
    this.app.get('/api/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      let seq = 0;
      const send = (event, data) => {
        try {
          res.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (_) { /* client gone */ }
      };
      send('hello', { ok: true, ts: Date.now() });

      const monitor = this.smartMonitor;
      const onComment = (m) => send('comment', m);
      const onVerdict = (v) => send('verdict', v);
      const onViolation = (v) => send('violation', {
        messageId: v?.message?.id,
        author: v?.message?.author,
        message: v?.message?.message,
        analysis: v?.analysis
      });
      const onStats = (s) => send('stats', s);
      const onStarted = (s) => send('started', s);
      const onStopped = () => send('stopped', { ok: true });
      const onError = (e) => send('error-evt', { message: String(e?.message || e) });

      if (monitor) {
        if (typeof monitor.getRecentComments === 'function') {
          for (const c of monitor.getRecentComments(50)) send('comment', c);
        }
        if (typeof monitor.getSmartStats === 'function') {
          send('stats', monitor.getSmartStats());
        }
        monitor.on('comment', onComment);
        monitor.on('verdict', onVerdict);
        monitor.on('violation', onViolation);
        monitor.on('stats', onStats);
        monitor.on('started', onStarted);
        monitor.on('stopped', onStopped);
        monitor.on('error', onError);
      }

      const heartbeat = setInterval(() => {
        try { res.write(`:keep-alive ${Date.now()}\n\n`); } catch (_) { /* noop */ }
      }, 15000);

      const cleanup = () => {
        clearInterval(heartbeat);
        if (monitor) {
          monitor.off('comment', onComment);
          monitor.off('verdict', onVerdict);
          monitor.off('violation', onViolation);
          monitor.off('stats', onStats);
          monitor.off('started', onStarted);
          monitor.off('stopped', onStopped);
          monitor.off('error', onError);
        }
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
    });

    // Moderation action history (warnings / timeout-tier / ban-tier chat messages)
    this.app.get('/api/moderation/actions', (req, res) => {
      try {
        if (!this.smartMonitor?.getModerationActions) {
          return res.json({ actions: [], total: 0, offset: 0, limit: 50 });
        }
        const limit = req.query.limit;
        const offset = req.query.offset;
        const result = this.smartMonitor.getModerationActions(limit, offset);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // YouTube authentication — JSON (SPA / fetch)
    this.app.get('/auth/youtube', async (req, res) => {
      try {
        if (!this.youtubeService.isOAuthConfigured()) {
          return res.status(503).json({
            error:
              'OAuth not configured. Open Settings and paste your Google OAuth Client ID and Secret.'
          });
        }
        const authUrl = await this.youtubeService.getAuthUrl();
        res.json({ authUrl, message: 'Open authUrl in your browser' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Browser-friendly: redirect straight to Google
    this.app.get('/login', async (req, res) => {
      try {
        if (!this.youtubeService.isOAuthConfigured()) {
          return res
            .status(503)
            .send(
              'OAuth not configured. Open Settings in the app and add your Google OAuth Client ID and Secret, then reload.'
            );
        }
        const authUrl = await this.youtubeService.getAuthUrl();
        res.redirect(authUrl);
      } catch (error) {
        res.status(500).send(error.message);
      }
    });

    // Legacy redirect URI without /auth prefix (optional)
    this.app.get('/callback', (req, res) => {
      const q = new URLSearchParams(req.query).toString();
      res.redirect(`/auth/callback${q ? `?${q}` : ''}`);
    });

    // Handle OAuth callback (must match redirect URI in Google Cloud + builtin.youtube.oauth)
    this.app.get('/auth/callback', async (req, res) => {
      try {
        const { code, state, error: oauthError } = req.query;
        if (oauthError) {
          console.error('Google OAuth error:', oauthError);
          return res.redirect(`/?auth=error&reason=${encodeURIComponent(oauthError)}`);
        }
        await this.youtubeService.handleCallback(code, state);
        res.redirect('/?auth=success');
      } catch (error) {
        console.error('Auth callback error:', error);
        res.redirect('/?auth=error');
      }
    });

    // Auth status for dashboard
    this.app.get('/api/auth/status', async (req, res) => {
      try {
        const status = await this.youtubeService.getAuthStatus();
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // OAuth credentials (stored locally in settings.json — use Settings tab in the app)
    this.app.get('/api/settings/oauth', (req, res) => {
      try {
        res.json(this.config.getOAuthPublicSnapshot(this.getListenPort()));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/settings/ai', (req, res) => {
      try {
        res.json(this.config.getAISettingsSnapshot());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Diagnostics — tells the UI whether secrets are stored in the OS keychain
    // (Keychain / DPAPI / libsecret) or in the plaintext fallback file. Never
    // returns the secret values themselves.
    this.app.get('/api/system/secrets', (req, res) => {
      try {
        res.json(this.config.describeSecrets());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // List models loaded in the user's LM Studio local server.
    // Optional ?url=http://host:port overrides the saved url for a "test before save".
    this.app.get('/api/ai/lmstudio/models', async (req, res) => {
      const raw = String(req.query.url || this.config.get('ai.lmstudio.url') || '').trim();
      const baseUrl = raw.replace(/\/+$/, '');
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: 'Missing LM Studio URL' });
      }
      let safe;
      try {
        safe = assertSafeLocalUrl(baseUrl);
      } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
      }
      const modelsPath = `${safe.origin}${safe.pathname.replace(/\/+$/, '')}/v1/models`;
      try {
        const r = await axios.get(modelsPath, { timeout: 4000, maxRedirects: 0 });
        const models = Array.isArray(r.data?.data) ? r.data.data : [];
        res.json({
          ok: true,
          url: baseUrl,
          models: models.map((m) => ({ id: m.id, name: m.id }))
        });
      } catch (error) {
        const code = error.code || (error.response && error.response.status) || 'ERR';
        res.status(200).json({
          ok: false,
          url: baseUrl,
          error: `Could not reach LM Studio at ${baseUrl} (${code}). Start LM Studio, load a model, then enable "Local Server".`
        });
      }
    });

    // List Gemini models for the saved (or supplied) API key.
    // Returns a small curated list as a safe fallback if no key is available yet.
    this.app.get('/api/ai/gemini/models', async (req, res) => {
      const fallback = [
        { id: 'gemini-2.0-flash', name: 'gemini-2.0-flash (fast, recommended)' },
        { id: 'gemini-1.5-flash', name: 'gemini-1.5-flash' },
        { id: 'gemini-1.5-flash-8b', name: 'gemini-1.5-flash-8b' },
        { id: 'gemini-1.5-pro', name: 'gemini-1.5-pro' }
      ];
      const key = String(req.query.apiKey || this.config.get('ai.gemini.apiKey') || '').trim();
      if (!key) {
        return res.json({ ok: true, source: 'curated', models: fallback });
      }
      try {
        const r = await axios.get(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          { timeout: 5000 }
        );
        const list = Array.isArray(r.data?.models) ? r.data.models : [];
        const models = list
          .filter((m) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent') &&
            String(m.name || '').includes('/gemini-')
          )
          .map((m) => {
            const id = String(m.name).replace(/^models\//, '');
            return { id, name: m.displayName ? `${id} — ${m.displayName}` : id };
          });
        res.json({
          ok: true,
          source: models.length ? 'api' : 'curated',
          models: models.length ? models : fallback
        });
      } catch (error) {
        res.json({
          ok: false,
          source: 'curated',
          models: fallback,
          error: `Could not list Gemini models (${error.response?.status || error.code || 'ERR'}). Showing common defaults.`
        });
      }
    });

    this.app.post('/api/settings/ai', async (req, res) => {
      try {
        const b = req.body || {};
        const provider = String(b.provider || 'gemini').trim();
        if (!['gemini', 'lmstudio', 'openai'].includes(provider)) {
          return res.status(400).json({ error: 'Invalid AI provider' });
        }
        this.config.set('ai.provider', provider);

        const fbRaw = b.fallbackProviders;
        const hasExplicitFallback =
          fbRaw != null && String(fbRaw).trim() !== '';
        if (hasExplicitFallback) {
          const list = Array.isArray(fbRaw)
            ? fbRaw
            : String(fbRaw).split(',');
          const cleaned = list.map((x) => String(x).trim()).filter(Boolean);
          if (cleaned.length) {
            this.config.set('ai.fallbackProviders', cleaned);
          }
        } else if (provider === 'gemini') {
          this.config.set('ai.fallbackProviders', ['lmstudio']);
        } else if (provider === 'lmstudio') {
          this.config.set('ai.fallbackProviders', ['gemini']);
        } else {
          this.config.set('ai.fallbackProviders', ['gemini', 'lmstudio']);
        }

        if (b.lmstudioUrl != null) {
          const candidate = String(b.lmstudioUrl).trim();
          try {
            assertSafeLocalUrl(candidate);
          } catch (e) {
            return res.status(400).json({ error: `LM Studio URL: ${e.message}` });
          }
          this.config.set('ai.lmstudio.url', candidate);
        }
        if (b.lmstudioModel != null) {
          this.config.set('ai.lmstudio.model', String(b.lmstudioModel).trim());
        }
        if (b.lmstudioTimeout != null && b.lmstudioTimeout !== '') {
          const t = parseInt(String(b.lmstudioTimeout), 10);
          if (!Number.isNaN(t) && t > 0) this.config.set('ai.lmstudio.timeout', t);
        }
        if (b.lmstudioMaxTokens != null && b.lmstudioMaxTokens !== '') {
          const m = parseInt(String(b.lmstudioMaxTokens), 10);
          if (!Number.isNaN(m) && m > 0) this.config.set('ai.lmstudio.maxTokens', m);
        }

        if (b.geminiModel != null) {
          this.config.set('ai.gemini.model', String(b.geminiModel).trim());
        }
        if (b.geminiApiKey != null && String(b.geminiApiKey).trim()) {
          this.config.set('ai.gemini.apiKey', String(b.geminiApiKey).trim());
        }

        if (b.openaiBaseUrl != null) {
          this.config.set('ai.openai.baseUrl', String(b.openaiBaseUrl).trim());
        }
        if (b.openaiModel != null) {
          this.config.set('ai.openai.model', String(b.openaiModel).trim());
        }
        if (b.openaiApiKey != null && String(b.openaiApiKey).trim()) {
          this.config.set('ai.openai.apiKey', String(b.openaiApiKey).trim());
        }

        this.config._validateConfig();
        await this.config.save();
        this.recreateAIService();
        res.json({
          success: true,
          message: 'AI settings saved. Provider is active now.',
          snapshot: this.config.getAISettingsSnapshot()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/settings/moderation', (req, res) => {
      try {
        res.json(this.config.getModerationSettingsSnapshot());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/settings/moderation', async (req, res) => {
      try {
        const b = req.body || {};
        if (typeof b.enabled === 'boolean') {
          this.config.set('moderation.enabled', b.enabled);
        }
        if (b.strictness != null && b.strictness !== '') {
          const st = String(b.strictness).trim();
          if (['low', 'medium', 'high'].includes(st)) {
            this.config.set('moderation.strictness', st);
          }
        }
        if (b.responses && typeof b.responses === 'object') {
          const r = b.responses;
          if (r.warning != null) {
            this.config.set('moderation.responses.warning', String(r.warning));
          }
          if (r.timeout != null) {
            this.config.set('moderation.responses.timeout', String(r.timeout));
          }
          if (r.ban != null) {
            this.config.set('moderation.responses.ban', String(r.ban));
          }
        }
        if (typeof b.autoRespond === 'boolean') {
          this.config.set('moderation.autoRespond', b.autoRespond);
        }
        if (typeof b.autoTimeout === 'boolean') {
          this.config.set('moderation.autoTimeout', b.autoTimeout);
        }
        if (typeof b.autoBan === 'boolean') {
          this.config.set('moderation.autoBan', b.autoBan);
        }
        if (b.timeoutSeconds != null && b.timeoutSeconds !== '') {
          const s = parseInt(String(b.timeoutSeconds), 10);
          if (!Number.isNaN(s)) {
            this.config.set(
              'moderation.timeoutSeconds',
              Math.min(3600, Math.max(60, s))
            );
          }
        }
        this.config._validateConfig();
        await this.config.save();
        this.recreateAIService();
        res.json({
          success: true,
          message: 'Moderation settings saved.',
          snapshot: this.config.getModerationSettingsSnapshot()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/settings/oauth', async (req, res) => {
      try {
        const { clientId, clientSecret } = req.body || {};
        if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
          return res.status(400).json({ error: 'clientId is required' });
        }
        if (
          clientSecret === undefined ||
          clientSecret === null ||
          (typeof clientSecret === 'string' && !clientSecret.trim())
        ) {
          return res.status(400).json({ error: 'clientSecret is required' });
        }
        const newId = String(clientId).trim();
        const newSecret = String(clientSecret).trim();
        const prevId = String(this.config.get('youtube.clientId') || '');
        const prevSecret = String(this.config.get('youtube.clientSecret') || '');
        const oauthChanged = newId !== prevId || newSecret !== prevSecret;

        this.config.set('youtube.clientId', newId);
        this.config.set('youtube.clientSecret', newSecret);
        await this.config.save();

        // Tokens that were minted for the previous OAuth client are unusable
        // with the new one. Clear them so the dashboard immediately shows
        // "Sign in with Google" instead of a confusing refresh failure.
        if (oauthChanged && this.youtubeService) {
          try { await this.youtubeService.signOut(); } catch (e) {
            console.warn('Token clear after OAuth change failed:', e.message);
          }
        }
        this.recreateYoutubeService();

        res.json({
          success: true,
          message: oauthChanged
            ? 'Credentials saved. Previous Google sign-in cleared — sign in again.'
            : 'Credentials saved.',
          snapshot: this.config.getOAuthPublicSnapshot(this.getListenPort())
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Explicit sign-out (clears stored tokens; OAuth client config stays).
    this.app.post('/api/auth/signout', async (req, res) => {
      try {
        if (!this.youtubeService) {
          return res.json({ success: true, message: 'Already signed out.' });
        }
        await this.youtubeService.signOut();
        res.json({ success: true, message: 'Signed out of Google.' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Connection test
    this.app.get('/api/test-connection', async (req, res) => {
      try {
        const result = await this.youtubeService.testConnection();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Start smart monitoring
    this.app.post('/api/monitoring/start', async (req, res) => {
      try {
        if (this.isMonitoring) {
          return res.status(400).json({ error: 'Already monitoring' });
        }

        const { videoId } = req.body || {};
        const result = await this.smartMonitor.start({ videoId });
        this.isMonitoring = true;
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Stop monitoring
    this.app.post('/api/monitoring/stop', async (req, res) => {
      try {
        const result = await this.smartMonitor.stop();
        this.isMonitoring = false;
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get comprehensive data
    this.app.get('/api/data/messages', async (req, res) => {
      try {
        if (!this.smartMonitor.messageDatabase) {
          return res.json({ messages: [], total: 0 });
        }
        
        const limit = parseApiInt(req.query.limit, 100, 1, MAX_API_LIMIT);
        const offset = parseApiInt(req.query.offset, 0, 0, MAX_API_OFFSET);
        const messages = this.smartMonitor.messageDatabase
          .slice(offset, offset + limit)
          .map(msg => ({
            id: msg.id,
            message: msg.message,
            author: msg.author,
            timestamp: msg.timestamp,
            processed: true
          }));
        
        res.json({ 
          messages, 
          total: this.smartMonitor.messageDatabase.length,
          showing: messages.length
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get analysis data
    this.app.get('/api/data/analysis', async (req, res) => {
      try {
        if (!this.smartMonitor.analysisDatabase) {
          return res.json({ analyses: [], total: 0 });
        }
        
        const limit = parseApiInt(req.query.limit, 100, 1, MAX_API_LIMIT);
        const offset = parseApiInt(req.query.offset, 0, 0, MAX_API_OFFSET);
        const analyses = this.smartMonitor.analysisDatabase.slice(offset, offset + limit);
        
        res.json({ 
          analyses, 
          total: this.smartMonitor.analysisDatabase.length,
          showing: analyses.length
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Configuration updates
    this.app.post('/api/config', async (req, res) => {
      try {
        const updates = req.body;
        await this.config.updateConfig(updates);
        res.json({ success: true, message: 'Configuration updated' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Initialize services
   */
  async _initializeServices() {
    // YouTube service
    this.youtubeService = new YouTubeService(this.config);

    // Eagerly migrate any legacy `tokens.json` into the SecretStore so the
    // file disappears even if the user hasn't kicked off OAuth yet on this run.
    try {
      if (this.youtubeService.tokenManager) {
        await this.youtubeService.tokenManager.loadStoredTokens();
      }
    } catch {
      // best-effort; lazy migration still covers later boots
    }

    // AI service
    this.aiService = new AIService(this.config);
    
    // Professional chat monitor
    this.smartMonitor = new ChatMonitor(
      this.youtubeService, 
      this.aiService, 
      this.config
    );

    // Setup event listeners
    this._setupEventListeners();
    
    console.log('Smart services initialized');
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    if (this.smartMonitor) {
      this.smartMonitor.on('violation', (data) => {
        console.log(`Smart violation: ${data.message.author} [${data.analysis.method}]`);
        this.emit('violation', data);
      });

      this.smartMonitor.on('messageAnalyzed', (data) => {
        // Optional: emit for real-time updates
        this.emit('messageAnalyzed', data);
      });

      this.smartMonitor.on('error', (error) => {
        console.error('Smart monitor error:', error);
      });

      this.smartMonitor.on('started', (data) => {
        console.log('Smart monitoring started:', data);
      });

      this.smartMonitor.on('stopped', (data) => {
        console.log('Smart monitoring stopped:', data.summary);
      });
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('Shutting down SafeStream…');
    
    if (this.isMonitoring) {
      await this.smartMonitor.stop();
    }

    if (this.server) {
      await new Promise((resolve, reject) => {
        this.server.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
      this._listenPort = null;
    }

    console.log('SafeStream shutdown complete');
  }
}

// Export and start if running directly
module.exports = SafeStream;

if (require.main === module) {
  const app = new SafeStream();
  
  app.initialize().catch(error => {
    console.error('Failed to start SafeStream:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await app.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await app.shutdown();
    process.exit(0);
  });
}