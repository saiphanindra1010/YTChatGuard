/**
 * Default YouTube OAuth credentials for local installs (no .env required).
 *
 * Google does not allow “sign in with Google” without registering an OAuth client.
 * Desktop apps are meant to ship a Client ID + Client Secret together; the secret
 * is not treated like a server-side password (see Google’s “Desktop” client docs).
 *
 * One-time setup for maintainers / forks:
 * 1. Google Cloud Console → APIs & Services → Enable “YouTube Data API v3”
 * 2. Credentials → Create OAuth client → Application type: Desktop app
 * 3. Add authorized redirect URI: http://localhost:3000/auth/callback
 *    (add http://127.0.0.1:3000/auth/callback and other ports you use)
 * 4. Paste Client ID and Client Secret below and commit (or keep private in a fork).
 *
 * End users then only run: npm install && npm start → Sign in with Google.
 */
module.exports = {
  clientId: '',
  clientSecret: ''
};
