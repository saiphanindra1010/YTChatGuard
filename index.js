/**
 * YTChatGuard Professional - Advanced Chat Moderation System
 * Intelligent AI-powered content analysis for YouTube live chat
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const EventEmitter = require('events');

// Import services
const ConfigManager = require('./src/config/ConfigManager');
const YouTubeService = require('./src/features/auth');
const ChatMonitor = require('./src/services/ChatMonitor');
const AIService = require('./src/services/AIService');

/**
 * YTChatGuard - Smart AI-Powered Live Chat Moderation
 * Records ALL messages + Uses AI smartly for optimal performance
 */
class YTChatGuard extends EventEmitter {
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

    console.log('🤖 YTChatGuard initialized - Smart AI moderation');
    console.log('✅ Records every message | 🧠 Uses AI intelligently');
  }

  /**
   * Initialize services and start server
   * @param {{ port?: number, electron?: boolean, oauthHost?: string }} [options]
   */
  async initialize(options = {}) {
    try {
      console.log('🚀 Initializing YTChatGuard Smart AI System...');
      console.log('📊 Features: Complete message recording + intelligent AI usage');

      await this.config.load();

      this._applyRuntimeOptions(options);

      this._setupExpress();

      await this._initializeServices();

      const port =
        this.config.get('server.port') ||
        this.config.get('app.port') ||
        3000;

      await new Promise((resolve, reject) => {
        this.server = this.app.listen(port, () => {
          const addr = this.server.address();
          this._listenPort =
            typeof addr === 'object' && addr ? addr.port : Number(port);
          const host =
            options.oauthHost ||
            (options.electron ? '127.0.0.1' : 'localhost');
          console.log(
            `✅ YTChatGuard running on http://${host}:${this._listenPort}`
          );
          console.log(`🌐 Open http://127.0.0.1:${this._listenPort} for the interface`);
          resolve(true);
        });
        this.server.once('error', reject);
      });

      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Smart system:', error);
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
    // Middleware
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.static(path.join(__dirname, 'src/public')));

    // Routes
    this._setupRoutes();
    this._setupDeveloperRoutes(); // Add developer-friendly routes
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
          stats: this.smartMonitor ? this.smartMonitor.getSmartStats() : {}
        }
      });
    });

    // Raw message data with pagination
    this.app.get('/api/dev/messages/raw', (req, res) => {
      const { page = 1, limit = 50 } = req.query;
      const offset = (page - 1) * limit;
      
      if (!this.smartMonitor?.messageDatabase) {
        return res.json({ messages: [], total: 0, page: 1, pages: 0 });
      }

      const total = this.smartMonitor.messageDatabase.length;
      const messages = this.smartMonitor.messageDatabase
        .slice(offset, offset + parseInt(limit))
        .map(msg => ({
          ...msg,
          messagePreview: msg.message.substring(0, 100),
          wordCount: msg.message.split(' ').length
        }));

      res.json({
        messages,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
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
            filename = `ytchatguard-messages-${timestamp}.json`;
            break;
          case 'analysis':
            data = this.smartMonitor?.analysisDatabase || [];
            filename = `ytchatguard-analysis-${timestamp}.json`;
            break;
          case 'users':
            data = Array.from(this.smartMonitor?.userProfiles?.values() || []);
            filename = `ytchatguard-users-${timestamp}.json`;
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

    console.log('🔧 Developer routes enabled: /dev, /api/debug, /api/dev/*');
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

    // Main interface (developer-friendly)
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'src/public/dashboard.html'));
    });

    // Smart statistics
    this.app.get('/api/smart-stats', (req, res) => {
      const stats = this.smartMonitor ? this.smartMonitor.getSmartStats() : {};
      res.json(stats);
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
          console.error('❌ Google OAuth error:', oauthError);
          return res.redirect(`/?auth=error&reason=${encodeURIComponent(oauthError)}`);
        }
        await this.youtubeService.handleCallback(code, state);
        res.redirect('/?auth=success');
      } catch (error) {
        console.error('❌ Auth callback error:', error);
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
          this.config.set('ai.lmstudio.url', String(b.lmstudioUrl).trim());
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
        if (typeof b.lmstudioUseLangGraph === 'boolean') {
          this.config.set('ai.lmstudio.useLangGraph', b.lmstudioUseLangGraph);
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
        this.config.set('youtube.clientId', String(clientId).trim());
        this.config.set('youtube.clientSecret', String(clientSecret).trim());
        await this.config.save();
        this.recreateYoutubeService();
        res.json({
          success: true,
          message: 'Credentials saved. You can sign in with Google.',
          snapshot: this.config.getOAuthPublicSnapshot(this.getListenPort())
        });
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
        
        const { limit = 100, offset = 0 } = req.query;
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
        
        const { limit = 100, offset = 0 } = req.query;
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
    
    console.log('✅ Smart services initialized');
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    if (this.smartMonitor) {
      this.smartMonitor.on('violation', (data) => {
        console.log(`🧠 Smart violation: ${data.message.author} [${data.analysis.method}]`);
        this.emit('violation', data);
      });

      this.smartMonitor.on('messageAnalyzed', (data) => {
        // Optional: emit for real-time updates
        this.emit('messageAnalyzed', data);
      });

      this.smartMonitor.on('error', (error) => {
        console.error('❌ Smart monitor error:', error);
      });

      this.smartMonitor.on('started', (data) => {
        console.log('🧠 Smart monitoring started:', data);
      });

      this.smartMonitor.on('stopped', (data) => {
        console.log('🧠 Smart monitoring stopped:', data.summary);
      });
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down YTChatGuard Smart...');
    
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

    console.log('✅ YTChatGuard Smart shutdown complete');
  }
}

// Export and start if running directly
module.exports = YTChatGuard;

if (require.main === module) {
  const app = new YTChatGuard();
  
  app.initialize().catch(error => {
    console.error('❌ Failed to start YTChatGuard:', error);
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