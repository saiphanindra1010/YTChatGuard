/**
 * SecretStore
 *
 * Stores credentials (Google OAuth client secret, Gemini / OpenAI API keys,
 * YouTube OAuth tokens) in an OS-protected location whenever possible:
 *   - Electron present + ready  → encrypted via electron.safeStorage
 *       macOS:   Keychain
 *       Windows: DPAPI / Credential Manager
 *       Linux:   libsecret (GNOME Keyring / KWallet) when DBus is available
 *   - Fallback (plain Node, headless Linux without keyring, etc.)
 *       → plaintext JSON written with 0o600 permissions, with a clear warning
 *
 * On disk: a single file (default `<userData>/secrets.enc`) holding either:
 *   - safeStorage-encrypted bytes of `JSON.stringify(map)`, or
 *   - plain UTF-8 JSON bytes (fallback)
 *
 * The file's first byte tells us which: encrypted blobs are arbitrary binary
 * (almost never start with `{`), plaintext JSON always starts with `{`.
 */

const fs = require('fs').promises;
const path = require('path');

const MODE_SAFE = 'safe';
const MODE_PLAIN = 'plaintext';

class SecretStore {
  /**
   * @param {{ filePath: string }} options
   */
  constructor({ filePath }) {
    this.filePath = filePath;
    this._cache = {};
    this._safeStorage = null;
    this._mode = MODE_PLAIN;
    this._loaded = false;
  }

  /**
   * Pick a backend and load the stored secrets (or start empty).
   * Returns the mode actually used: 'safe' | 'plaintext'.
   */
  async init() {
    this._safeStorage = this._tryLoadSafeStorage();
    this._mode = this._safeStorage ? MODE_SAFE : MODE_PLAIN;

    await this._load();

    if (this._mode === MODE_PLAIN) {
      console.warn(
        'SecretStore: OS keychain not available — secrets stored as plaintext JSON ' +
          `at ${this.filePath} (0600). Run inside the Electron app to encrypt.`
      );
    } else {
      console.log(
        `SecretStore: using OS keychain (electron.safeStorage) for ${this.filePath}`
      );
    }

    this._loaded = true;
    return this._mode;
  }

  get mode() {
    return this._mode;
  }

  get isEncrypted() {
    return this._mode === MODE_SAFE;
  }

  /** Internal — return the Electron safeStorage API only when usable. */
  _tryLoadSafeStorage() {
    try {
      // Electron exposes a STRING (the executable path) when required from a
      // plain Node process. The real API exists only inside the Electron main
      // process, where `require('electron')` returns an object.
      // eslint-disable-next-line global-require
      const electron = require('electron');
      if (!electron || typeof electron !== 'object') return null;
      const ss = electron.safeStorage;
      if (!ss || typeof ss.isEncryptionAvailable !== 'function') return null;
      // `isEncryptionAvailable()` is only true once `app.whenReady()` has
      // fired and the keychain backend is reachable.
      if (!ss.isEncryptionAvailable()) return null;
      return ss;
    } catch {
      return null;
    }
  }

  async _load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._cache = {};
        return;
      }
      throw err;
    }

    if (raw.length === 0) {
      this._cache = {};
      return;
    }

    // Plaintext fallback files always begin with `{`
    const looksLikeJson = raw[0] === 0x7b; // '{'

    if (looksLikeJson) {
      try {
        this._cache = JSON.parse(raw.toString('utf8'));
      } catch {
        console.warn(
          `SecretStore: could not parse plaintext secrets at ${this.filePath} — starting empty.`
        );
        this._cache = {};
      }
      return;
    }

    // Otherwise it should be an encrypted blob. We need safeStorage to read it.
    if (!this._safeStorage) {
      console.warn(
        `SecretStore: ${this.filePath} is encrypted but Electron safeStorage is not available right now. ` +
          'Open the Electron app to read these secrets — leaving them on disk untouched.'
      );
      this._cache = {};
      return;
    }

    try {
      const txt = this._safeStorage.decryptString(raw);
      this._cache = JSON.parse(txt);
    } catch (err) {
      console.warn(
        `SecretStore: failed to decrypt ${this.filePath}: ${err.message}. ` +
          'This usually means the OS keychain entry was rotated or the file was copied between machines. Starting empty.'
      );
      this._cache = {};
    }
  }

  async save() {
    if (!this._loaded) {
      throw new Error('SecretStore.save() called before init()');
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this._cache);

    if (this._mode === MODE_SAFE && this._safeStorage) {
      const buf = this._safeStorage.encryptString(json);
      await fs.writeFile(this.filePath, buf);
    } else {
      // 0o600 — owner read/write only. fs.writeFile honors `mode` on POSIX.
      await fs.writeFile(this.filePath, json, { mode: 0o600 });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // best-effort; Windows ignores POSIX modes
      }
    }
  }

  /** Return a stored secret, or `undefined` when missing/empty. */
  get(key) {
    const v = this._cache[key];
    if (v == null || v === '') return undefined;
    return v;
  }

  has(key) {
    const v = this._cache[key];
    return v != null && v !== '';
  }

  /** Set or clear a secret. Empty / null deletes the entry. */
  set(key, value) {
    if (value == null || value === '') {
      delete this._cache[key];
    } else {
      this._cache[key] = value;
    }
  }

  delete(key) {
    delete this._cache[key];
  }

  /** Snapshot for diagnostics (does NOT include secret values). */
  describe() {
    return {
      mode: this._mode,
      filePath: this.filePath,
      keys: Object.keys(this._cache).sort()
    };
  }
}

module.exports = SecretStore;
