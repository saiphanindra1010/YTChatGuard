# SafeStream

**AI-assisted YouTube live chat moderation**

A moderation stack that watches YouTube live chat and uses configurable AI backends (OpenAI, Gemini, LM Studio) to keep sessions cleaner and easier to manage.

## Overview

SafeStream merges file-based settings with optional environment overrides so you can run it locally, in Electron, or behind your own port and OAuth redirect URLs.

## Features

- **Real-time moderation** — Monitors live chat and applies your rules and templates.
- **Multi-model AI** — Pluggable providers with sensible fallbacks.
- **Alerts** — Surfaces actions so moderators can step in when needed.

## Setup

1. Clone this repository.
2. Install dependencies: `npm install`.
3. Copy `.env.example` to `.env` and add YouTube API credentials plus your chosen AI keys.
4. Adjust moderation behavior in `src/features/commands.ts` if you use command hooks.
5. Build and run: `npm run build`, then `npm start` (web server) or `npm run desktop` (Electron loads `dist/`). For development with reload, use `npm run dev` or `npm run dev:desktop`.

### Configuration (`settings.json`)

**Electron (including DMG installers)** never expects you to hand-edit environment variables or ship a repo `settings.json`: the shell passes **`app.getPath('userData')`** straight into SafeStream — the canonical OS-owned directory (macOS example: **`~/Library/Application Support/SafeStream/`** inside your user profile). SafeStream writes **`settings.json`**, **`secrets.enc`**, and **`tokens.json`** there on first run. You do **not** put secrets in the `.dmg` bundle; they stay beside your login’s profile with **`0600`**-style Unix permissions where supported.

Development from this repo keeps using **`src/config/settings.json`** when no user-data directory is provided (plain `node` / `npm start`).

Defaults are merged from the app on load, so new keys appear safely on upgrade.

Under **`app`**, optional security-related keys (**non‑packaged Electron / CLI**):

| Key | Meaning |
| --- | ------- |
| `enableDeveloperRoutes` | `true` enables `/api/debug` and `/api/dev/*`. Default `false`. `npm run dev` passes **`--developer-routes`**. |
| `lmStudioUrlsLocalhostOnly` | When `true`, LM Studio base URLs must be loopback-only (`localhost` / `127.*` / `::1`). |

**Signed / packaged** Electron builds (`app.isPackaged`): developer routes stay **hard-disabled** regardless of editing `settings.json`, and LM Studio URLs are enforced as **loopback-only** **before** startup validation finishes—so SSRF‑style LM URLs on the LAN cannot be enabled by tweaking the saved file alone.

Advanced operators can still set **`SAFESTREAM_*`** vars for portability tools; DMG installs do not rely on users doing that—paths are pinned from Electron’s **`userData`**.

Developer routes toggling is driven by **`app.enableDeveloperRoutes`**, **`--developer-routes`**, and the packaged Electron rules above (not legacy `SAFESTREAM_DEV_ROUTES`-style env knobs for DMG installs).

### Environment variables (optional paths / secrets)

Electron sets **`SAFESTREAM_USER_DATA`** internally before the server starts when you run the desktop app; you don’t need to configure it for a normal DMG install. Other **`SAFESTREAM_`** / **`YTCHATGUARD_`** variables remain available for edge hosting or automation. Optional **`.env`** in the project root is loaded at startup for CLI development (`import 'dotenv/config'`).

## Security notes

- **Dependency audit:** Transitive `uuid` issues (GHSA-w5hq-g745-h8pq) are avoided by not bundling `@langchain/*` (LM Studio moderation uses the official `openai` client instead) and by keeping `googleapis` on a current release. After changing dependencies, run `npm audit`.
- **Local HTTP server:** The app listens only on `127.0.0.1` and rejects unexpected `Host` / `Origin` headers so other machines on the network cannot reach the dashboard by default.
- **HTTP hardening:** Non-browser methods like `TRACE`/`TRACK`/`CONNECT` are rejected, JSON bodies are limited to 512 KB, and common browser security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`) are applied to responses from this process.
- **Developer routes:** Packaged Electron **always** keeps `/api/debug` and `/api/dev/*` off. Unpackaged Electron / Node can opt in via **`app.enableDeveloperRoutes`** or **`--developer-routes`** / **`--dev-tools`**.
- **LM Studio URL:** Validated against the URL allowlist. Packaged Electron **requires** loopback-only LM Studio hosts. For dev / CLI, set **`app.lmStudioUrlsLocalhostOnly`** if you want the same rule without packaging.
- **Local API token:** Each server run generates a random secret injected into the dashboard HTML and sent as `X-SafeStream-Token` on API calls. SSE (EventSource) uses `?_ss_token` because custom headers are not supported. Treat the token like a bearer secret; anyone who can execute script in your dashboard origin can misuse it once.
- **OAuth:** YouTube login uses OAuth2 with PKCE and a one-time server-side `state` binding.
- **Electron:** Renderer uses `sandbox: true`, `webSecurity: true`, disabled `allowRunningInsecureContent`, denied pop-ups, navigation limited to localhost / `*.google.com`, CSP on local responses (**`script-src 'self'`** — no inline script; dashboard logic in `/js/dashboard-app.js`; API token bootstrap via **`meta`** + base64 JSON). **`style-src`** still allows **`'unsafe-inline'`** (themes / Tailwind utilities). **`settings.json`** / **`secrets.enc`** live under **`userData`** with restrictive Unix permissions where supported.

If you duplicate this setup on a VPS or LAN IP, tighten network exposure (reverse proxy TLS, firewall, auth beyond the ephemeral token).
