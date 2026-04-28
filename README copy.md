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
4. Adjust moderation behavior in `commands.js` if you use command hooks.
5. Run the app: `npm start` (web server) or `npm run desktop` (Electron shell).

### Environment (Electron / advanced)

Primary variables use the `SAFESTREAM_` prefix (for example `SAFESTREAM_USER_DATA`, `SAFESTREAM_PORT`, `SAFESTREAM_ENV_OVERRIDES`). The older `YTCHATGUARD_*` names are still read where applicable for backward compatibility.

## Security notes

- **Dependency audit:** Transitive `uuid` issues (GHSA-w5hq-g745-h8pq) are avoided by not bundling `@langchain/*` (LM Studio moderation uses the official `openai` client instead) and by keeping `googleapis` on a current release. After changing dependencies, run `npm audit`.
- **Local HTTP server:** The app listens only on `127.0.0.1` and rejects unexpected `Host` / `Origin` headers so other machines on the network cannot reach the dashboard by default.
- **LM Studio URL:** Only `http`/`https` URLs pointing at localhost or private LAN addresses are accepted for LM Studio, to limit SSRF from the settings and model-list endpoints.
- **Local API token:** Each server run generates a random secret injected into the dashboard HTML and sent as `X-SafeStream-Token` on API calls. Export links append `_ss_token` as a query parameter. OAuth browser flows use `http://127.0.0.1` or `localhost` plus Google sign-in hosts only (see Electron navigation rules).
- **Electron:** Renderer uses `sandbox: true`, pop-ups are denied, navigation is restricted to localhost and `*.google.com`, and a Content Security Policy is applied to responses from the local server.
