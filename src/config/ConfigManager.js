const fs = require('fs').promises;
const path = require('path');
const SecretStore = require('./SecretStore');

/** Prefer SAFESTREAM_*; YTCHATGUARD_* kept for backward compatibility. */
function appEnv(name) {
  const next = process.env[`SAFESTREAM_${name}`];
  if (next != null && next !== '') return next;
  return process.env[`YTCHATGUARD_${name}`];
}

function loadBuiltinYoutubeOAuth() {
  try {
    return require(path.join(__dirname, 'builtin.youtube.oauth'));
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

/**
 * Config paths whose values are credentials. They are kept in SecretStore
 * (OS keychain via electron.safeStorage when possible) and stripped from
 * `settings.json` so the file on disk is safe to back up / sync.
 */
const SECRET_PATHS = [
  'youtube.clientSecret',
  'ai.gemini.apiKey',
  'ai.openai.apiKey'
];

/**
 * Configuration Manager — loads `settings.json`, merges defaults, optional env overrides.
 */
class ConfigManager {
  constructor() {
    const userDataDir = appEnv('USER_DATA');
    this.configPath = userDataDir
      ? path.join(userDataDir, 'settings.json')
      : path.join(process.cwd(), 'src', 'config', 'settings.json');
    const builtinYt = loadBuiltinYoutubeOAuth();
    /** Defaults only — real values come from settings.json (and optional env if SAFESTREAM_ENV_OVERRIDES=1). */
    this.defaultConfig = {
      ai: {
        provider: 'lmstudio',
        fallbackProviders: ['gemini'],
        streaming: true,
        concurrency: 4,
        queueMaxDepth: 200,
        gemini: {
          apiKey: '',
          model: 'gemini-2.0-flash'
        },
        lmstudio: {
          url: 'http://localhost:1234',
          model: 'local-model',
          timeout: 8000,
          maxTokens: 60
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
        pollInterval: 1500,
        pollIntervalMin: 500,
        pollIntervalMax: 3000,
        processorIdleDelayMs: 50,
        processorBusyDelayMs: 0,
        maxFastBatchPerTick: 200
      }
    };

    this.config = { ...this.defaultConfig };
    this.watchers = new Set();

    const secretsPath = appEnv('SECRETS_PATH')
      ? appEnv('SECRETS_PATH')
      : path.join(path.dirname(this.configPath), 'secrets.enc');
    this.secrets = new SecretStore({ filePath: secretsPath });
  }

  /**
   * Load configuration from file and environment
   */
  async load() {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });

      // Initialize the OS-keychain-backed secret store (or its plaintext fallback)
      // BEFORE we read settings.json so we can migrate any plaintext secrets out.
      await this.secrets.init();

      let fileConfig = null;
      try {
        const fileContent = await fs.readFile(this.configPath, 'utf8');
        fileConfig = JSON.parse(fileContent);
        this.config = this._deepMerge(this.defaultConfig, fileConfig);
        console.log('Configuration loaded from file');
      } catch (error) {
        console.log('No existing config file, using defaults');
        this.config = { ...this.defaultConfig };
      }

      // One-time migration: pull any plaintext secrets that were sitting in
      // settings.json (legacy installs, builtin.youtube.oauth.js, etc.) into
      // the SecretStore, then null them out in the in-memory copy so they
      // never get written back to settings.json on the next save.
      let migrated = false;
      for (const p of SECRET_PATHS) {
        const v = this._getNestedValue(this.config, p);
        if (typeof v === 'string' && v.trim()) {
          if (!this.secrets.has(p)) {
            this.secrets.set(p, v);
            migrated = true;
          }
        }
      }
      if (migrated) {
        await this.secrets.save();
        console.log('Migrated plaintext secrets from settings.json into SecretStore.');
      }

      // Hydrate in-memory config from SecretStore so AIService / YouTubeService
      // can keep using `config.get('ai.gemini.apiKey')` unchanged.
      for (const p of SECRET_PATHS) {
        const v = this.secrets.get(p);
        if (v != null) this._setNestedValue(this.config, p, v);
      }

      // PORT always honors process.env (hosting / Electron). Other env vars only if opted in.
      this._applyEnvironmentOverrides();

      // If settings.json had blank OAuth fields, still allow builtin.youtube.oauth.js
      this._applyBuiltinYoutubeFallback();

      this._validateConfig();

      // Always run save() at least once so that any plaintext secrets that
      // existed in settings.json get stripped from disk after the migration.
      const onDiskHasSecrets = SECRET_PATHS.some((p) => {
        const v = this._getNestedValue(fileConfig || {}, p);
        return typeof v === 'string' && v.trim() !== '';
      });
      const nextContent = JSON.stringify(this._configForDisk(), null, 2);
      let shouldPersist = onDiskHasSecrets;
      try {
        const prev = await fs.readFile(this.configPath, 'utf8');
        if (
          !onDiskHasSecrets &&
          prev.replace(/\r\n/g, '\n').trimEnd() ===
            nextContent.replace(/\r\n/g, '\n').trimEnd()
        ) {
          shouldPersist = false;
        }
      } catch {
        shouldPersist = true;
      }
      if (shouldPersist) await this.save();

      return this.config;
    } catch (error) {
      console.error('Failed to load configuration:', error);
      throw error;
    }
  }

  /**
   * Save current configuration to file. Secrets are stripped from the on-disk
   * blob; they live in SecretStore (and thus in the OS keychain when Electron
   * safeStorage is available).
   */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      const onDisk = this._configForDisk();
      await fs.writeFile(this.configPath, JSON.stringify(onDisk, null, 2));
      console.log('Configuration saved');

      this.watchers.forEach((callback) => callback(this.config));
    } catch (error) {
      console.error('Failed to save configuration:', error);
      throw error;
    }
  }

  /**
   * Build the JSON blob for `settings.json` with every SECRET_PATHS field
   * replaced by an empty string. We keep the empty placeholders so the file
   * still validates against existing readers (and so users grepping for the
   * key in their config can see it exists, just empty).
   */
  _configForDisk() {
    const clone = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      const cur = this._getNestedValue(clone, p);
      if (typeof cur === 'string' && cur !== '') {
        this._setNestedValue(clone, p, '');
      }
    }
    return clone;
  }

  /**
   * Diagnostic helper exposed via /api/system/secrets — describes only the
   * SecretStore's mode and present keys, never the values.
   */
  describeSecrets() {
    return this.secrets.describe();
  }

  /**
   * Get configuration value by path
   */
  get(path) {
    return this._getNestedValue(this.config, path);
  }

  /**
   * Set configuration value by path. For SECRET_PATHS the value is also
   * mirrored into SecretStore, but the in-memory copy is updated immediately
   * so subsequent `get()` calls in the same request return the new value
   * without an awkward async hop. Callers that care about durability still
   * need to `await config.save()` (which persists settings.json AND the
   * secret store).
   */
  set(path, value) {
    this._setNestedValue(this.config, path, value);
    if (SECRET_PATHS.includes(path)) {
      this.secrets.set(path, typeof value === 'string' ? value : '');
      // Fire and forget — we'll be awaited via save() at the end of the
      // settings POST handler, but keep the secret store in sync even if
      // the caller forgets. Errors are logged inside SecretStore.
      this.secrets.save().catch((err) => {
        console.error('SecretStore save failed:', err.message);
      });
    }
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
      electron:
        process.env.SAFESTREAM_ELECTRON === '1' ||
        process.env.YTCHATGUARD_ELECTRON === '1'
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
        maxTokens: Number(this.get('ai.lmstudio.maxTokens')) || 180
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
        'YouTube OAuth not configured: add Client ID and Secret in System → Google OAuth (or builtin.youtube.oauth.js).'
      );
    }

    // Validate AI provider specific settings
    if (aiProvider === 'gemini' && !this.get('ai.gemini.apiKey')) {
      console.warn('Gemini API key not configured');
    }

    if (aiProvider === 'lmstudio') {
      const url = this.get('ai.lmstudio.url');
      try {
        const { assertSafeLocalUrl } = require('./UrlAllowlist');
        assertSafeLocalUrl(url);
      } catch (e) {
        errors.push(`Invalid LM Studio URL: ${e.message}`);
      }
    }

    if (aiProvider === 'openai' && !this.get('ai.openai.apiKey')) {
      console.warn('OpenAI API key not configured');
    }

    // Validate moderation settings
    const strictness = this.get('moderation.strictness');
    if (!['low', 'medium', 'high'].includes(strictness)) {
      errors.push(`Invalid moderation strictness: ${strictness}`);
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    console.log('Configuration validation passed');
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

    if (
      process.env.SAFESTREAM_ENV_OVERRIDES !== '1' &&
      process.env.YTCHATGUARD_ENV_OVERRIDES !== '1'
    ) {
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

    console.log(
      'SAFESTREAM_ENV_OVERRIDES=1 (or legacy YTCHATGUARD_ENV_OVERRIDES=1): full environment overrides applied'
    );
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