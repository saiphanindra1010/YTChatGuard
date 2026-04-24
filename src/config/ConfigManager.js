const fs = require('fs').promises;
const path = require('path');

function loadBuiltinYoutubeOAuth() {
  try {
    return require(path.join(__dirname, 'builtin.youtube.oauth'));
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

/**
 * Configuration Manager — loads `settings.json`, merges defaults, optional env overrides.
 */
class ConfigManager {
  constructor() {
    this.configPath = process.env.YTCHATGUARD_USER_DATA
      ? path.join(process.env.YTCHATGUARD_USER_DATA, 'settings.json')
      : path.join(process.cwd(), 'src', 'config', 'settings.json');
    const builtinYt = loadBuiltinYoutubeOAuth();
    /** Defaults only — real values come from settings.json (and optional env if YTCHATGUARD_ENV_OVERRIDES=1). */
    this.defaultConfig = {
      ai: {
        provider: 'lmstudio',
        fallbackProviders: ['gemini'],
        gemini: {
          apiKey: '',
          model: 'gemini-2.0-flash'
        },
        lmstudio: {
          url: 'http://localhost:1234',
          model: 'local-model',
          timeout: 12000,
          maxTokens: 180,
          useLangGraph: true
        },
        openai: {
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-3.5-turbo'
        }
      },
      youtube: {
        clientId: builtinYt.clientId || '',
        clientSecret: builtinYt.clientSecret || '',
        redirectUri: 'http://localhost:3000/auth/callback',
        scopes: [
          'https://www.googleapis.com/auth/youtube.readonly',
          'https://www.googleapis.com/auth/youtube',
          'https://www.googleapis.com/auth/youtube.force-ssl'
        ],
        pollInterval: 5000
      },
      moderation: {
        enabled: true,
        strictness: 'medium',
        autoRespond: true,
        autoTimeout: false,
        autoBan: false,
        timeoutSeconds: 300,
        maxWarnings: 3,
        categories: {
          toxicity: true,
          harassment: true,
          hateSpeech: true,
          spam: true,
          nsfw: true,
          violence: true
        },
        responses: {
          warning:
            '{author} ⚠️ Please keep the chat respectful. This is your warning.',
          timeout:
            '{author} 🚫 Your message violated community guidelines.',
          ban: '{author} ❌ You have been banned for repeated violations.',
          custom: []
        },
        whitelist: { users: [], keywords: [] },
        blacklist: { keywords: [], patterns: [] }
      },
      app: {
        port: 3000,
        logLevel: 'info'
      },
      server: {
        port: 3000
      },
      smart: {
        pollInterval: 2500,
        processorIdleDelayMs: 280,
        processorBusyDelayMs: 45,
        maxFastBatchPerTick: 48
      }
    };

    this.config = { ...this.defaultConfig };
    this.watchers = new Set();
  }

  /**
   * Load configuration from file and environment
   */
  async load() {
    try {
      // Ensure config directory exists
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });

      // Try to load existing config
      try {
        const fileContent = await fs.readFile(this.configPath, 'utf8');
        const fileConfig = JSON.parse(fileContent);
        
        // Merge file config with defaults
        this.config = this._deepMerge(this.defaultConfig, fileConfig);
        console.log('✅ Configuration loaded from file');
      } catch (error) {
        console.log('📝 No existing config file, using defaults');
        this.config = { ...this.defaultConfig };
      }

      // PORT always honors process.env (hosting / Electron). Other env vars only if opted in.
      this._applyEnvironmentOverrides();

      // If settings.json had blank OAuth fields, still allow builtin.youtube.oauth.js
      this._applyBuiltinYoutubeFallback();
      
      // Validate configuration
      this._validateConfig();

      // Persist merged config only when it actually changed (avoids touching the file on
      // every boot — unnecessary writes also trigger nodemon if *.json is watched).
      const nextContent = JSON.stringify(this.config, null, 2);
      let shouldPersist = true;
      try {
        const prev = await fs.readFile(this.configPath, 'utf8');
        if (prev.replace(/\r\n/g, '\n').trimEnd() === nextContent.replace(/\r\n/g, '\n').trimEnd()) {
          shouldPersist = false;
        }
      } catch {
        // no file yet — must save
      }
      if (shouldPersist) await this.save();

      return this.config;
    } catch (error) {
      console.error('❌ Failed to load configuration:', error);
      throw error;
    }
  }

  /**
   * Save current configuration to file
   */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('✅ Configuration saved');
      
      // Notify watchers
      this.watchers.forEach(callback => callback(this.config));
    } catch (error) {
      console.error('❌ Failed to save configuration:', error);
      throw error;
    }
  }

  /**
   * Get configuration value by path
   */
  get(path) {
    return this._getNestedValue(this.config, path);
  }

  /**
   * Set configuration value by path
   */
  set(path, value) {
    this._setNestedValue(this.config, path, value);
  }

  /**
   * Update multiple configuration values
   */
  async update(updates) {
    for (const [path, value] of Object.entries(updates)) {
      this.set(path, value);
    }
    await this.save();
  }

  /**
   * Alias for API routes expecting updateConfig
   */
  async updateConfig(updates) {
    return this.update(updates);
  }

  /**
   * Full config for debug endpoints (secrets redacted)
   */
  getAllConfig() {
    const raw = JSON.parse(JSON.stringify(this.config));
    const redact = (obj, path) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        const p = `${path}.${k}`;
        if (/secret|apiKey|api_key|password|token/i.test(k) && typeof obj[k] === 'string') {
          obj[k] = obj[k] ? '***' : '';
        } else if (typeof obj[k] === 'object' && obj[k] !== null) {
          redact(obj[k], p);
        }
      }
    };
    redact(raw, 'config');
    return raw;
  }

  /**
   * Safe snapshot for Settings UI (never exposes client secret).
   */
  getOAuthPublicSnapshot(listenPort) {
    const id = this.get('youtube.clientId') || '';
    const hasSecret = !!this.get('youtube.clientSecret');
    return {
      configured: !!(id && hasSecret),
      hasClientId: !!id,
      hasClientSecret: hasSecret,
      clientId: id,
      redirectUri: this.get('youtube.redirectUri') || '',
      listenPort:
        listenPort != null ? listenPort : this.get('server.port') || this.get('app.port'),
      electron: process.env.YTCHATGUARD_ELECTRON === '1'
    };
  }

  /**
   * Safe snapshot for AI settings UI (API keys: presence only, not values).
   */
  getAISettingsSnapshot() {
    const gKey = this.get('ai.gemini.apiKey');
    const oKey = this.get('ai.openai.apiKey');
    const rawFb = this.get('ai.fallbackProviders');
    const fallbackProviders = Array.isArray(rawFb)
      ? rawFb.map((s) => String(s).trim()).filter(Boolean)
      : String(rawFb || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    return {
      provider: this.get('ai.provider') || 'gemini',
      fallbackProviders:
        fallbackProviders.length > 0 ? fallbackProviders : ['gemini', 'lmstudio'],
      gemini: {
        model: this.get('ai.gemini.model') || 'gemini-2.0-flash',
        hasApiKey: !!(gKey && String(gKey).trim())
      },
      lmstudio: {
        url: this.get('ai.lmstudio.url') || 'http://localhost:1234',
        model: this.get('ai.lmstudio.model') || 'local-model',
        timeout: Number(this.get('ai.lmstudio.timeout')) || 12000,
        maxTokens: Number(this.get('ai.lmstudio.maxTokens')) || 180,
        useLangGraph: this.get('ai.lmstudio.useLangGraph') !== false
      },
      openai: {
        baseUrl: this.get('ai.openai.baseUrl') || 'https://api.openai.com/v1',
        model: this.get('ai.openai.model') || 'gpt-3.5-turbo',
        hasApiKey: !!(oKey && String(oKey).trim())
      }
    };
  }

  /** Safe snapshot for moderation / YouTube enforcement UI */
  getModerationSettingsSnapshot() {
    const rs = this.get('moderation.responses') || {};
    return {
      enabled: this.get('moderation.enabled') !== false,
      strictness: this.get('moderation.strictness') || 'medium',
      autoRespond: this.get('moderation.autoRespond') !== false,
      autoTimeout: this.get('moderation.autoTimeout') === true,
      autoBan: this.get('moderation.autoBan') === true,
      timeoutSeconds: Math.min(
        3600,
        Math.max(60, Number(this.get('moderation.timeoutSeconds')) || 300)
      ),
      responses: {
        warning: String(rs.warning || ''),
        timeout: String(rs.timeout || ''),
        ban: String(rs.ban || '')
      }
    };
  }

  /**
   * Watch for configuration changes
   */
  watch(callback) {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  /**
   * Get current configuration status
   */
  getStatus() {
    const features = this.get('features');
    const featureEntries =
      features && typeof features === 'object' ? Object.entries(features) : [];
    return {
      loaded: true,
      configPath: this.configPath,
      aiProvider: this.get('ai.provider'),
      moderationEnabled: this.get('moderation.enabled'),
      featuresEnabled: featureEntries
        .filter(([_, enabled]) => enabled)
        .map(([feature]) => feature),
      lastModified: new Date().toISOString()
    };
  }

  /**
   * Validate configuration
   */
  _validateConfig() {
    const errors = [];

    // Validate AI configuration
    const aiProvider = this.get('ai.provider');
    if (!['gemini', 'lmstudio', 'openai'].includes(aiProvider)) {
      errors.push(`Invalid AI provider: ${aiProvider}`);
    }

    // YouTube OAuth — Google requires a registered client; use Settings UI or builtin.youtube.oauth.js
    if (!this.get('youtube.clientId') || !this.get('youtube.clientSecret')) {
      console.warn(
        '⚠️  YouTube OAuth not configured: add Client ID and Secret in System → Google OAuth (or builtin.youtube.oauth.js).'
      );
    }

    // Validate AI provider specific settings
    if (aiProvider === 'gemini' && !this.get('ai.gemini.apiKey')) {
      console.warn('⚠️  Gemini API key not configured');
    }

    if (aiProvider === 'lmstudio') {
      const url = this.get('ai.lmstudio.url');
      if (!url.startsWith('http')) {
        errors.push('Invalid LMStudio URL format');
      }
    }

    if (aiProvider === 'openai' && !this.get('ai.openai.apiKey')) {
      console.warn('⚠️  OpenAI API key not configured');
    }

    // Validate moderation settings
    const strictness = this.get('moderation.strictness');
    if (!['low', 'medium', 'high'].includes(strictness)) {
      errors.push(`Invalid moderation strictness: ${strictness}`);
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    console.log('✅ Configuration validation passed');
  }

  /**
   * Fill YouTube OAuth from builtin file when merged config still has no credentials.
   */
  _applyBuiltinYoutubeFallback() {
    const b = loadBuiltinYoutubeOAuth();
    if (!this.get('youtube.clientId') && b.clientId) {
      this.set('youtube.clientId', b.clientId);
    }
    if (!this.get('youtube.clientSecret') && b.clientSecret) {
      this.set('youtube.clientSecret', b.clientSecret);
    }
  }

  /**
   * Apply environment variable overrides
   */
  _applyEnvironmentOverrides() {
    if (process.env.PORT) {
      const p = parseInt(process.env.PORT, 10);
      if (!Number.isNaN(p) && p > 0) {
        this.set('app.port', p);
        this.set('server.port', p);
        // Keep the dashboard-shown OAuth redirect URI in sync so users copy
        // a URL that actually matches what the server is listening on.
        const cur = String(this.get('youtube.redirectUri') || '');
        if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/auth\/callback$/.test(cur)) {
          const host = cur.includes('127.0.0.1') ? '127.0.0.1' : 'localhost';
          this.set('youtube.redirectUri', `http://${host}:${p}/auth/callback`);
        }
      }
    }

    if (process.env.YTCHATGUARD_ENV_OVERRIDES !== '1') {
      return;
    }

    // AI settings
    if (process.env.AI_PROVIDER) this.set('ai.provider', process.env.AI_PROVIDER);
    if (process.env.GoogleGenerativeAI) this.set('ai.gemini.apiKey', process.env.GoogleGenerativeAI);
    if (process.env.LMSTUDIO_URL) this.set('ai.lmstudio.url', process.env.LMSTUDIO_URL);
    if (process.env.LMSTUDIO_MODEL) this.set('ai.lmstudio.model', process.env.LMSTUDIO_MODEL);
    if (process.env.LMSTUDIO_TIMEOUT) {
      this.set('ai.lmstudio.timeout', parseInt(process.env.LMSTUDIO_TIMEOUT, 10));
    }
    if (process.env.LMSTUDIO_MAX_TOKENS) {
      this.set('ai.lmstudio.maxTokens', parseInt(process.env.LMSTUDIO_MAX_TOKENS, 10));
    }
    if (process.env.LMSTUDIO_USE_LANGGRAPH) {
      this.set(
        'ai.lmstudio.useLangGraph',
        process.env.LMSTUDIO_USE_LANGGRAPH !== 'false'
      );
    }
    if (process.env.OPENAI_API_KEY) this.set('ai.openai.apiKey', process.env.OPENAI_API_KEY);

    // YouTube settings
    if (process.env.CLIENT_ID) this.set('youtube.clientId', process.env.CLIENT_ID);
    if (process.env.CLIENT_SECRET) this.set('youtube.clientSecret', process.env.CLIENT_SECRET);
    if (process.env.REDIRECT_URI) this.set('youtube.redirectUri', process.env.REDIRECT_URI);

    // Moderation settings
    if (process.env.MODERATION_STRICTNESS) {
      this.set('moderation.strictness', process.env.MODERATION_STRICTNESS);
    }
    if (process.env.MODERATION_AUTO_TIMEOUT === 'true') {
      this.set('moderation.autoTimeout', true);
    }
    if (process.env.MODERATION_AUTO_TIMEOUT === 'false') {
      this.set('moderation.autoTimeout', false);
    }
    if (process.env.MODERATION_AUTO_BAN === 'true') {
      this.set('moderation.autoBan', true);
    }
    if (process.env.MODERATION_AUTO_BAN === 'false') {
      this.set('moderation.autoBan', false);
    }
    if (process.env.MODERATION_TIMEOUT_SECONDS) {
      const s = parseInt(process.env.MODERATION_TIMEOUT_SECONDS, 10);
      if (!Number.isNaN(s)) this.set('moderation.timeoutSeconds', Math.min(3600, Math.max(60, s)));
    }

    console.log('🔄 YTCHATGUARD_ENV_OVERRIDES=1: full environment overrides applied');
  }

  /**
   * Deep merge objects
   */
  _deepMerge(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  /**
   * Get nested value by dot notation path
   */
  _getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Set nested value by dot notation path
   */
  _setNestedValue(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((current, key) => {
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      return current[key];
    }, obj);
    
    target[lastKey] = value;
  }
}

module.exports = ConfigManager;