/**
 * Optional baked-in Google OAuth Desktop client (maintainers only).
 *
 * **Retail Electron install (.exe/.dmg):** Leave `clientId` and `clientSecret` empty.
 * End users paste both in **System → Google OAuth** and click Save — no `.env`,
 * no bundled secrets file. Same for AI keys in the AI settings card (`SECRET_PATHS`
 * in ConfigManager → `SecretStore` + OS crypto when Electron `safeStorage` works).
 *
 * **Fork/internal builds:** Google requires a Desktop OAuth client. You may paste ID
 * and secret here OR leave empty and distribute credentials out-of-band; never commit
 * real secrets to a public repo.
 *
 * Redirect URIs must match the port your build uses (e.g. Electron default).
 */
export const clientId = '';
export const clientSecret = '';
