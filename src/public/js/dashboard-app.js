(function safeStreamHydrateBootstrap() {
    try {
        const m = document.querySelector('meta[name="safestream-bootstrap"]');
        const b64 = m?.getAttribute('content')?.trim();
        if (!b64) return;
        const o = JSON.parse(atob(b64));
        if (typeof o.apiToken === 'string' && o.apiToken.length > 0) {
            window.__SAFESTREAM_API_TOKEN__ = o.apiToken;
        }
    } catch (_) {}
})();

        const THEME_STORAGE_KEY = 'safestream-theme';
        /** Order + swatches — keep in sync with tailwind.config.js `daisyui.themes`. Colors from DaisyUI theme tokens (primary, secondary, accent, neutral). */
        async function apiFetch(url, opts) {
            const o = opts || {};
            const headers = new Headers(o.headers || {});
            let t = typeof window.__SAFESTREAM_API_TOKEN__ === 'string' ? window.__SAFESTREAM_API_TOKEN__ : '';
            if (!t && window.safestream && typeof window.safestream.getApiToken === 'function') {
                try {
                    t = await window.safestream.getApiToken();
                } catch (e) {
                    t = '';
                }
            }
            if (t) headers.set('X-SafeStream-Token', t);
            return fetch(url, { ...o, headers });
        }

        async function googleSignIn() {
            try {
                const r = await apiFetch('/auth/youtube');
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Sign-in failed');
                if (d.authUrl) window.location.href = d.authUrl;
            } catch (e) {
                addLog(`Sign-in: ${e.message}`, 'error');
            }
        }

        const DAISY_THEMES = [
            { id: 'autumn', label: 'autumn', sw: ['#8C0327', '#D85251', '#D59B6A', '#826A5C'] },
            { id: 'business', label: 'business', sw: ['#1C4E80', '#7C909A', '#EA6947', '#23282E'] },
            { id: 'acid', label: 'acid', sw: ['#f472b6', '#fb923c', '#bef264', '#1e1b4b'] },
            { id: 'lemonade', label: 'lemonade', sw: ['#4ade80', '#86efac', '#fde047', '#365314'] },
            { id: 'night', label: 'night', sw: ['#38bdf8', '#818CF8', '#F471B5', '#1E293B'] },
            { id: 'coffee', label: 'coffee', sw: ['#DB924B', '#263E3F', '#10576D', '#120C12'] },
            { id: 'winter', label: 'winter', sw: ['#3b82f6', '#463AA2', '#C148AC', '#021431'] },
            { id: 'dim', label: 'dim', sw: ['#9FE88D', '#FF7D5C', '#C792E9', '#1c212b'] },
            { id: 'nord', label: 'nord', sw: ['#5E81AC', '#81A1C1', '#88C0D0', '#4C566A'] },
            { id: 'sunset', label: 'sunset', sw: ['#FF865B', '#FD6F9C', '#B387FA', '#3d4a5c'] }
        ];

        let isMonitoring = false;
        let statsInterval;
        let currentTab = 'monitor';

        function getStoredTheme() {
            const fallback = 'autumn';
            const allowed = new Set(DAISY_THEMES.map((t) => t.id));
            try {
                const raw = localStorage.getItem(THEME_STORAGE_KEY) || fallback;
                return allowed.has(raw) ? raw : fallback;
            } catch (e) {
                return fallback;
            }
        }

        function themeSwatchInnerHTML(sw) {
            return sw
                .map(
                    (c) =>
                        `<span class="ss-theme-dot" style="background:${c}"></span>`
                )
                .join('');
        }

        function syncThemePickerUI(activeId) {
            const meta = DAISY_THEMES.find((t) => t.id === activeId);
            const labelEl = document.getElementById('themeMenuBtnLabel');
            const swatchEl = document.getElementById('themeMenuBtnSwatch');
            if (labelEl && meta) labelEl.textContent = meta.label;
            if (swatchEl && meta) swatchEl.innerHTML = themeSwatchInnerHTML(meta.sw);
            const panel = document.getElementById('themeMenuPanel');
            if (panel) {
                panel.querySelectorAll('[role="option"]').forEach((row) => {
                    const id = row.getAttribute('data-theme-id');
                    const on = id === activeId;
                    row.setAttribute('aria-selected', on ? 'true' : 'false');
                    const check = row.querySelector('.ss-theme-check');
                    if (check) check.classList.toggle('opacity-0', !on);
                });
            }
        }

        function setThemeMenuOpen(open) {
            const btn = document.getElementById('themeMenuBtn');
            const panel = document.getElementById('themeMenuPanel');
            if (!btn || !panel) return;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            panel.classList.toggle('hidden', !open);
            panel.hidden = !open;
        }

        function applyTheme(name) {
            const allowed = new Set(DAISY_THEMES.map((t) => t.id));
            const resolved = allowed.has(name) ? name : 'autumn';
            document.documentElement.setAttribute('data-theme', resolved);
            try {
                localStorage.setItem(THEME_STORAGE_KEY, resolved);
            } catch (e) {}
            syncThemePickerUI(resolved);
        }

        function initThemeSelect() {
            const btn = document.getElementById('themeMenuBtn');
            const panel = document.getElementById('themeMenuPanel');
            if (!btn || !panel || btn.dataset.themeInited === '1') return;
            btn.dataset.themeInited = '1';

            panel.innerHTML = DAISY_THEMES.map((t) => {
                const sw = themeSwatchInnerHTML(t.sw);
                return `<button type="button" role="option" data-theme-id="${t.id}" title="Change theme"
                    class="ss-theme-row flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-base-200">
                    <span class="ss-theme-swatch-grid shrink-0" aria-hidden="true">${sw}</span>
                    <span class="flex-1 text-sm font-medium lowercase text-base-content">${t.label}</span>
                    <span class="ss-theme-check flex h-5 w-5 shrink-0 items-center justify-center text-base-content opacity-0" aria-hidden="true">
                        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/></svg>
                    </span>
                </button>`;
            }).join('');

            panel.querySelectorAll('[role="option"]').forEach((row) => {
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = row.getAttribute('data-theme-id');
                    if (id) applyTheme(id);
                    setThemeMenuOpen(false);
                });
            });

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = btn.getAttribute('aria-expanded') === 'true';
                setThemeMenuOpen(!open);
            });

            document.addEventListener('click', () => setThemeMenuOpen(false));
            panel.addEventListener('click', (e) => e.stopPropagation());

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') setThemeMenuOpen(false);
            });

            applyTheme(getStoredTheme());
        }

        function initElectronTitlebar() {
            const api = window.safestream;
            if (!api) return;
            if (api.platform === 'darwin') {
                document.documentElement.classList.add('ss-electron-mac');
            }
            const bar = document.getElementById('electronTitlebar');
            if (bar) bar.classList.remove('hidden');
            const iconMax = document.getElementById('electronIconMax');
            function setMaxIcon(isMax) {
                if (!iconMax) return;
                if (isMax) {
                    iconMax.innerHTML =
                        '<rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><rect x="0" y="0" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/>';
                } else {
                    iconMax.innerHTML =
                        '<rect x="0" y="0" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"/>';
                }
            }
            document.getElementById('electronBtnMin')?.addEventListener('click', () => api.minimizeWindow());
            document.getElementById('electronBtnMax')?.addEventListener('click', () => api.toggleMaximize());
            document.getElementById('electronBtnClose')?.addEventListener('click', () => api.closeWindow());
            if (typeof api.onMaximizedChange === 'function') {
                api.onMaximizedChange((isMax) => setMaxIcon(isMax));
            }
        }

        function actionTypePill(type) {
            const t = (type || 'warning').toLowerCase();
            const cls = t === 'ban' ? 'badge-error' : t === 'timeout' ? 'badge-info' : 'badge-warning';
            const label = t === 'ban' ? 'Ban notice' : t === 'timeout' ? 'Timeout' : 'Warning';
            return `<span class="badge ${cls} badge-sm badge-outline">${label}</span>`;
        }

        function severityPill(sev) {
            const s = (sev || 'low').toLowerCase();
            const cls = s === 'high' ? 'badge-error' : s === 'medium' ? 'badge-warning' : 'badge-ghost';
            const safe = ['low', 'medium', 'high'].includes(s) ? s : 'low';
            return `<span class="badge ${cls} badge-sm">${safe}</span>`;
        }

        function youtubeApiPill(a) {
            const yt = a.youtubeAction;
            const tier = (a.actionType || '').toLowerCase();
            if (!yt || yt === 'none') {
                if (tier === 'ban' || tier === 'timeout') {
                    const hint = tier === 'ban'
                        ? 'Auto YouTube ban toggle is OFF in System → YouTube enforcement. The bot decided “ban” but did not call the YouTube API.'
                        : 'Auto YouTube timeout toggle is OFF in System → YouTube enforcement. The bot decided “timeout” but did not call the YouTube API.';
                    return `<span class="badge badge-warning badge-sm badge-outline" title="${escapeHtml(hint)}">disabled</span>`;
                }
                return '<span class="opacity-40">—</span>';
            }
            if (a.youtubeActionOk) {
                const lab = yt === 'timeout' ? 'Timeout' : yt === 'ban' ? 'Ban' : String(yt);
                return `<span class="badge badge-success badge-sm badge-outline">${escapeHtml(lab)}</span>`;
            }
            const err = escapeHtml(a.youtubeActionError || 'error');
            return `<span class="badge badge-error badge-sm badge-outline" title="${err}">Fail</span>`;
        }

        function escapeHtml(s) {
            if (s == null) return '';
            const d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        }

        async function loadModerationActions() {
            const tbody = document.getElementById('actionsTableBody');
            const totalEl = document.getElementById('actionsTotal');
            try {
                const r = await apiFetch('/api/moderation/actions?limit=100&offset=0');
                const data = await r.json();
                const rows = data.actions || [];
                totalEl.textContent = `${data.total || 0} actions recorded`;
                if (!rows.length) {
                    tbody.innerHTML =
                        '<tr><td colspan="8" class="opacity-50">No moderation actions yet.</td></tr>';
                    return;
                }
                tbody.innerHTML = rows
                    .map((a) => {
                        const at = a.at ? new Date(a.at).toLocaleString() : '—';
                        const planned = escapeHtml((a.plannedText || a.chatResponse || '').slice(0, 200));
                        let reply;
                        if (a.responseSent) {
                            reply = planned;
                        } else if (!a.autoRespondEnabled) {
                            reply = planned
                                ? `${planned} <span class="opacity-50">(not sent)</span>`
                                : '<span class="opacity-50">—</span>';
                        } else {
                            reply = `<span class="opacity-50">Send failed: ${escapeHtml(a.responseError || 'unknown')}</span>`;
                        }
                        return `<tr>
                        <td class="font-mono-ss text-xs whitespace-nowrap">${escapeHtml(at)}</td>
                        <td>${actionTypePill(a.actionType)}</td>
                        <td class="whitespace-nowrap">${youtubeApiPill(a)}</td>
                        <td><strong>${escapeHtml(a.author || '—')}</strong><div class="mt-1 font-mono-ss text-[11px] opacity-60">${escapeHtml((a.authorId || '').slice(0, 18))}${(a.authorId || '').length > 18 ? '…' : ''}</div></td>
                        <td>${severityPill(a.severity)}</td>
                        <td class="font-mono-ss text-xs">${escapeHtml(a.method || '—')}</td>
                        <td class="max-w-[14rem] text-xs opacity-80">${escapeHtml(a.messagePreview || '')}</td>
                        <td class="max-w-[14rem] text-xs opacity-80">${reply}</td>
                    </tr>`;
                    })
                    .join('');
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="8" class="opacity-50">Could not load: ${escapeHtml(e.message)}</td></tr>`;
            }
        }

        function setNavActive(tabName) {
            document.querySelectorAll('.nav-item').forEach((btn) => {
                const isActive = btn.dataset.tab === tabName;
                btn.classList.toggle('border-primary', isActive);
                btn.classList.toggle('bg-primary/10', isActive);
                btn.classList.toggle('font-semibold', isActive);
                btn.classList.toggle('border-transparent', !isActive);
                if (isActive) btn.setAttribute('aria-current', 'page');
                else btn.removeAttribute('aria-current');
            });
        }

        function switchTab(tabName) {
            currentTab = tabName;
            setNavActive(tabName);
            document.querySelectorAll('.ss-page').forEach((content) => {
                content.classList.toggle('hidden', content.id !== tabName);
            });
            if (tabName === 'system') {
                window.dispatchEvent(new CustomEvent('oauth-card-reload'));
                window.dispatchEvent(new CustomEvent('ai-card-reload'));
                window.dispatchEvent(new CustomEvent('mod-card-reload'));
                initThemeSelect();
            }
            if (tabName === 'insights') loadModerationActions();
        }

        function addLog(message, type = 'info') {
            const container = document.getElementById('activityLog');
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            const time = new Date().toLocaleTimeString();
            const cls = {
                info: 'text-info',
                success: 'text-success',
                warning: 'text-warning',
                error: 'text-error'
            };
            pre.className = 'log-slide';
            pre.setAttribute('data-prefix', '~');
            code.className = cls[type] || cls.info;
            code.textContent = `[${time}] ${message}`;
            pre.appendChild(code);
            container.appendChild(pre);
            const scrollWrap = container.closest('.overflow-y-auto') || container;
            scrollWrap.scrollTop = scrollWrap.scrollHeight;
        }

        function addDebugLog(message, type = 'info') {
            const container = document.getElementById('debugLog');
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            const time = new Date().toLocaleTimeString();
            const cls = {
                info: 'text-info',
                success: 'text-success',
                warning: 'text-warning',
                error: 'text-error'
            };
            pre.className = 'log-slide';
            pre.setAttribute('data-prefix', '~');
            code.className = cls[type] || cls.info;
            code.textContent = `[${time}] ${message}`;
            pre.appendChild(code);
            container.appendChild(pre);
            const scrollWrap = container.closest('.overflow-y-auto') || container;
            scrollWrap.scrollTop = scrollWrap.scrollHeight;
        }

        function clearLogs() {
            document.getElementById('activityLog').innerHTML =
                '<pre data-prefix="~" class="log-slide"><code class="text-info">Logs cleared</code></pre>';
        }

        async function testConnection() {
            addLog('Testing YouTube connection…', 'info');
            try {
                const response = await apiFetch('/api/test-connection', { method: 'GET' });
                const result = await response.json();
                if (result.success) {
                    addLog('Connected successfully', 'success');
                    updateStatus('connected');
                } else {
                    addLog(`Failed: ${result.error}`, 'error');
                }
            } catch (error) {
                addLog(`Error: ${error.message}`, 'error');
            }
        }

        async function toggleMonitoring() {
            const btn = document.getElementById('monitorBtn');
            if (!isMonitoring) {
                const videoId = document.getElementById('videoId').value.trim();
                try {
                    const response = await apiFetch('/api/monitoring/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(videoId ? { videoId } : {})
                    });
                    const result = await response.json();
                    if (result.success) {
                        isMonitoring = true;
                        btn.textContent = 'Stop monitoring';
                        btn.classList.remove('btn-primary');
                        btn.classList.add('btn-error');
                        addLog('Monitoring started', 'success');
                        updateStatus('active');
                        startStatsUpdates();
                    } else {
                        addLog(`Failed: ${result.error}`, 'error');
                    }
                } catch (error) {
                    addLog(`Error: ${error.message}`, 'error');
                }
            } else {
                try {
                    await apiFetch('/api/monitoring/stop', { method: 'POST' });
                    isMonitoring = false;
                    btn.textContent = 'Start monitoring';
                    btn.classList.add('btn-primary');
                    btn.classList.remove('btn-error');
                    addLog('Monitoring stopped', 'info');
                    updateStatus('connected');
                    // Keep SSE open — server will simply pause emitting events
                    // until monitoring restarts. This way reconnect lag is zero.
                } catch (error) {
                    addLog(`Error: ${error.message}`, 'error');
                }
            }
        }

        function updateStatus(status) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            dot.classList.remove('bg-error', 'bg-warning', 'bg-success', 'animate-pulse');
            const states = {
                offline: { cls: 'bg-error', label: 'Offline', pulse: true },
                connected: { cls: 'bg-warning', label: 'Connected', pulse: true },
                active: { cls: 'bg-success', label: 'Monitoring', pulse: true }
            };
            const s = states[status] || states.offline;
            dot.classList.add(s.cls);
            if (s.pulse) dot.classList.add('animate-pulse');
            text.textContent = s.label;
        }

        function applyStats(stats) {
            if (!stats) return;
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            set('totalMessages', stats.totalMessages || 0);
            set('flaggedMessages', stats.flaggedMessages || 0);
            set('aiProcessed', stats.aiProcessed || 0);
            set('efficiency', `${stats.efficiency || 0}%`);
            const eff = Math.min(100, Math.max(0, stats.efficiency || 0));
            set('efficiencyRate', `${eff}%`);
            const bar = document.getElementById('efficiencyBar');
            if (bar && bar.tagName === 'PROGRESS') bar.value = eff;
            set('avgResponseTime', `${stats.avgResponseTime || 0}ms`);
            set('cacheHitRate', `${stats.cacheHitRate || 0}%`);
            set('processed', stats.processed || 0);
            set('cached', stats.cached || 0);
            set('skipped', stats.skipped || 0);
            const ma = stats.moderationActions || {};
            set('maWarning', ma.warning ?? 0);
            set('maTimeout', ma.timeout ?? 0);
            set('maBan', ma.ban ?? 0);
        }

        const MAX_RENDERED_COMMENTS = 500;
        const renderedCommentIds = new Set();

        function escapeText(s) {
            return String(s == null ? '' : s);
        }

        function addComment(c) {
            if (!c || !c.id) return;
            if (renderedCommentIds.has(c.id)) return;
            renderedCommentIds.add(c.id);

            const container = document.getElementById('activityLog');
            if (!container) return;

            const pre = document.createElement('pre');
            pre.className = 'log-slide';
            pre.setAttribute('data-prefix', '>');
            pre.setAttribute('data-msg-id', c.id);

            const code = document.createElement('code');
            code.className = 'opacity-90';
            const time = new Date(c.timestamp || Date.now()).toLocaleTimeString();
            const role = c.isOwner ? '[owner] ' : c.isModerator ? '[mod] ' : '';
            code.textContent = `[${time}] ${role}${escapeText(c.author)}: ${escapeText(c.message)}`;
            pre.appendChild(code);
            container.appendChild(pre);

            while (container.children.length > MAX_RENDERED_COMMENTS) {
                const first = container.firstElementChild;
                const id = first?.getAttribute?.('data-msg-id');
                if (id) renderedCommentIds.delete(id);
                container.removeChild(first);
            }

            const scrollWrap = container.closest('.overflow-y-auto') || container;
            scrollWrap.scrollTop = scrollWrap.scrollHeight;
        }

        function applyVerdict(v) {
            if (!v || !v.messageId) return;
            const container = document.getElementById('activityLog');
            if (!container) return;
            const node = container.querySelector(`[data-msg-id="${CSS.escape(v.messageId)}"] code`);
            if (!node) return;
            node.classList.remove('opacity-90', 'text-success', 'text-warning', 'text-error', 'text-info');
            if (v.isViolation) {
                const sev = (v.severity || 'medium').toLowerCase();
                node.classList.add(sev === 'high' ? 'text-error' : sev === 'low' ? 'text-warning' : 'text-warning');
                const tag = ` ⛔ ${v.severity || ''} (${v.method || ''}${v.ttfvMs ? `, ${v.ttfvMs}ms` : v.processingTime ? `, ${v.processingTime}ms` : ''})`;
                node.textContent += tag;
            } else {
                node.classList.add('text-success');
                const tag = ` ✓ (${v.method || ''}${v.ttfvMs ? `, ${v.ttfvMs}ms` : v.processingTime != null ? `, ${v.processingTime}ms` : ''})`;
                node.textContent += tag;
            }
        }

        let liveStream = null;

        function startStatsUpdates() {
            if (liveStream && liveStream.readyState !== 2 /* CLOSED */) return;
            try {
                const tok = (typeof window.__SAFESTREAM_API_TOKEN__ === 'string')
                    ? window.__SAFESTREAM_API_TOKEN__ : '';
                const url = `/api/events?_ss_token=${encodeURIComponent(tok)}`;
                liveStream = new EventSource(url);

                liveStream.addEventListener('hello', () => addLog('Live stream connected', 'info'));
                liveStream.addEventListener('stats', (e) => {
                    try { applyStats(JSON.parse(e.data)); } catch (_) { /* noop */ }
                });
                liveStream.addEventListener('comment', (e) => {
                    try { addComment(JSON.parse(e.data)); } catch (_) { /* noop */ }
                });
                liveStream.addEventListener('verdict', (e) => {
                    try { applyVerdict(JSON.parse(e.data)); } catch (_) { /* noop */ }
                });
                liveStream.addEventListener('violation', (e) => {
                    try {
                        const v = JSON.parse(e.data);
                        addLog(`Violation: ${v.author} — ${v.analysis?.reasoning || ''}`, 'warning');
                    } catch (_) { /* noop */ }
                });
                liveStream.addEventListener('started', () => addLog('Monitoring started (server)', 'success'));
                liveStream.addEventListener('stopped', () => addLog('Monitoring stopped (server)', 'info'));
                liveStream.addEventListener('error-evt', (e) => {
                    try {
                        const v = JSON.parse(e.data);
                        addLog(`Server error: ${v.message}`, 'error');
                    } catch (_) { /* noop */ }
                });
                liveStream.onerror = () => {
                    // EventSource auto-reconnects; we just surface a notice.
                };
            } catch (err) {
                console.error('SSE setup failed:', err);
            }
        }

        function stopStatsUpdates() {
            if (liveStream) {
                try { liveStream.close(); } catch (_) { /* noop */ }
                liveStream = null;
            }
        }

        async function refreshSystemInfo() {
            try {
                const response = await apiFetch('/api/debug');
                const debug = await response.json();
                const mon = debug.monitoring || {};
                const stats = mon.stats || {};
                const cfg = debug.config || {};
                const aiProv =
                    cfg.ai && cfg.ai.provider != null ? String(cfg.ai.provider) : '—';
                const isActive = !!mon.isRunning;
                const msgCount = stats.totalMessages ?? 0;
                const sys = debug.system || {};
                const uptimeSec = Math.floor(sys.uptime || 0);
                const videoLabel =
                    mon.videoId != null && mon.videoId !== ''
                        ? String(mon.videoId)
                        : 'None';
                const statusCls = isActive ? 'text-success' : 'text-error';
                const statusLabel = isActive ? 'Active' : 'Inactive';
                document.getElementById('systemInfo').innerHTML = `
                    <div class="flex flex-col gap-2.5">
                    <div class="flex justify-between gap-4 text-xs leading-snug"><span class="text-base-content/60">Status</span><span class="font-medium ${statusCls}">${statusLabel}</span></div>
                    <div class="flex justify-between gap-4 text-xs leading-snug"><span class="text-base-content/60">Video</span><span class="text-right font-mono-ss">${escapeHtml(videoLabel)}</span></div>
                    <div class="flex justify-between gap-4 text-xs leading-snug"><span class="text-base-content/60">Messages</span><span class="font-mono-ss font-medium">${escapeHtml(String(msgCount))}</span></div>
                    <div class="flex justify-between gap-4 text-xs leading-snug"><span class="text-base-content/60">AI</span><span class="font-mono-ss">${escapeHtml(aiProv)}</span></div>
                    <div class="flex justify-between gap-4 text-xs leading-snug"><span class="text-base-content/60">Uptime</span><span class="font-mono-ss">${escapeHtml(String(uptimeSec))}s</span></div>
                    </div>
                `;
                addDebugLog('Refreshed', 'success');
            } catch (error) {
                addDebugLog(`Error: ${error.message}`, 'error');
            }
        }

        async function testAI() {
            const message = document.getElementById('testMessage').value;
            if (!message) {
                addDebugLog('Enter a message', 'warning');
                return;
            }
            addDebugLog(`Testing: "${message}"`, 'info');
            try {
                const response = await apiFetch('/api/dev/test-ai', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });
                const result = await response.json();
                document.getElementById('aiTestResult').textContent = JSON.stringify(result, null, 2);
                addDebugLog('Test complete', 'success');
            } catch (error) {
                addDebugLog(`Error: ${error.message}`, 'error');
            }
        }

        async function loadRawMessages() {
            try {
                const response = await apiFetch('/api/dev/messages/raw?limit=20');
                const messages = await response.json();
                document.getElementById('rawMessages').textContent = JSON.stringify(messages, null, 2);
                addDebugLog('Loaded', 'success');
            } catch (error) {
                addDebugLog(`Error: ${error.message}`, 'error');
            }
        }

        async function exportData(format) {
            let t = typeof window.__SAFESTREAM_API_TOKEN__ === 'string' ? window.__SAFESTREAM_API_TOKEN__ : '';
            if (!t && window.safestream && typeof window.safestream.getApiToken === 'function') {
                try {
                    t = await window.safestream.getApiToken();
                } catch (e) {
                    t = '';
                }
            }
            const q = t ? `?${new URLSearchParams({ _ss_token: t })}` : '';
            window.open(`/api/dev/export/${encodeURIComponent(format)}${q}`, '_blank');
            addDebugLog(`Exported ${format}`, 'success');
        }

        async function refreshAuthBanner() {
            const text = document.getElementById('authBannerText');
            const banner = document.getElementById('authBanner');
            const link = document.getElementById('signInLink');
            const settingsBtn = document.getElementById('openSettingsBtn');
            try {
                const r = await apiFetch('/api/auth/status');
                const s = await r.json();
                banner.classList.remove('alert-warning', 'alert-success', 'alert-info');
                if (!s.oauthConfigured) {
                    text.textContent = s.message || 'Open System: add Google OAuth credentials, then choose Gemini or LM Studio.';
                    banner.classList.add('alert', 'alert-warning');
                    settingsBtn.classList.remove('hidden');
                    link.classList.add('hidden');
                    return;
                }
                settingsBtn.classList.add('hidden');
                link.classList.remove('hidden');
                if (s.authenticated && s.channel) {
                    text.textContent = `Signed in as ${s.channel.title}`;
                    banner.classList.add('alert', 'alert-success');
                    link.textContent = 'Re-connect Google';
                } else {
                    let msg;
                    let tone = 'alert-info';
                    switch (s.reason) {
                        case 'never_signed_in':
                            msg = 'Sign in with Google to read your YouTube live chat.';
                            break;
                        case 'needs_reauth':
                            msg = 'Your Google sign-in expired or was revoked — sign in again to continue.';
                            tone = 'alert-warning';
                            break;
                        case 'refresh_failed':
                            msg = 'Could not refresh your Google session (network issue?). Try again, or sign in to start fresh.';
                            tone = 'alert-warning';
                            break;
                        default:
                            msg = s.message || 'Sign in to access your live chat.';
                    }
                    text.textContent = msg;
                    banner.classList.add('alert', tone);
                    link.textContent = 'Sign in with Google';
                }
            } catch (e) {
                text.textContent = 'Could not load auth status.';
                banner.classList.add('alert', 'alert-warning');
            }
        }

        // Alpine.js component — AI moderation card.
        // Tracks all provider/model fields reactively; the Save button is
        // disabled until the in-memory snapshot diverges from the last loaded one.
        function aiCard() {
            const DEFAULT_GEMINI_MODELS = [
                { id: 'gemini-2.0-flash', name: 'gemini-2.0-flash (fast, recommended)' },
                { id: 'gemini-1.5-flash', name: 'gemini-1.5-flash' },
                { id: 'gemini-1.5-flash-8b', name: 'gemini-1.5-flash-8b' },
                { id: 'gemini-1.5-pro', name: 'gemini-1.5-pro' }
            ];
            return {
                loaded: false,
                saving: false,
                status: '',
                statusKind: '',
                provider: 'gemini',
                useOpenai: false,
                fallbackProviders: '',
                lmstudio: { url: '', model: '', timeout: 30000, maxTokens: 256 },
                gemini: { model: 'gemini-2.0-flash', apiKey: '', hasApiKey: false },
                openai: { baseUrl: '', model: '', apiKey: '', hasApiKey: false },
                lmstudioModels: [],
                lmstudioModelsHint: '',
                lmstudioRefreshing: false,
                geminiModels: DEFAULT_GEMINI_MODELS.slice(),
                geminiModelsHint: '',
                geminiRefreshing: false,
                initialSnapshot: '',

                get effectiveProvider() {
                    return this.useOpenai ? 'openai' : this.provider;
                },
                get currentSnapshot() {
                    return JSON.stringify({
                        provider: this.effectiveProvider,
                        fallback: this.fallbackProviders.trim(),
                        lmstudio: {
                            url: this.lmstudio.url.trim(),
                            model: (this.lmstudio.model || '').trim(),
                            timeout: Number(this.lmstudio.timeout) || 0,
                            maxTokens: Number(this.lmstudio.maxTokens) || 0
                        },
                        gemini: {
                            model: (this.gemini.model || '').trim(),
                            apiKey: this.gemini.apiKey
                        },
                        openai: {
                            baseUrl: this.openai.baseUrl.trim(),
                            model: this.openai.model.trim(),
                            apiKey: this.openai.apiKey
                        }
                    });
                },
                get dirty() {
                    return this.loaded && this.currentSnapshot !== this.initialSnapshot;
                },

                async init() {
                    await this.load();
                    this.$watch('provider', (v) => {
                        if (this.useOpenai) return;
                        if (v === 'lmstudio' && this.lmstudioModels.length === 0) {
                            this.refreshLmstudio();
                        }
                    });
                },

                _ensureModelOption(list, model, suffix = ' (saved)') {
                    if (!model) return list;
                    if (list.some((m) => m.id === model)) return list;
                    return [{ id: model, name: model + suffix }, ...list];
                },

                async load() {
                    try {
                        const r = await apiFetch('/api/settings/ai');
                        if (!r.ok) throw new Error('Load failed');
                        const s = await r.json();
                        this.useOpenai = s.provider === 'openai';
                        this.provider = this.useOpenai ? 'gemini' : (s.provider || 'gemini');
                        this.fallbackProviders = Array.isArray(s.fallbackProviders)
                            ? s.fallbackProviders.join(', ')
                            : (s.fallbackProviders || '');
                        if (s.lmstudio) {
                            this.lmstudio.url = s.lmstudio.url || '';
                            this.lmstudio.model = s.lmstudio.model || '';
                            this.lmstudio.timeout = s.lmstudio.timeout ?? 30000;
                            this.lmstudio.maxTokens = s.lmstudio.maxTokens ?? 256;
                            this.lmstudioModels = this._ensureModelOption([], this.lmstudio.model);
                        }
                        if (s.gemini) {
                            this.gemini.model = s.gemini.model || 'gemini-2.0-flash';
                            this.gemini.apiKey = '';
                            this.gemini.hasApiKey = !!s.gemini.hasApiKey;
                            this.geminiModels = this._ensureModelOption(
                                DEFAULT_GEMINI_MODELS.slice(),
                                this.gemini.model,
                                ''
                            );
                        }
                        if (s.openai) {
                            this.openai.baseUrl = s.openai.baseUrl || '';
                            this.openai.model = s.openai.model || '';
                            this.openai.apiKey = '';
                            this.openai.hasApiKey = !!s.openai.hasApiKey;
                        }
                        this.loaded = true;
                        this.initialSnapshot = this.currentSnapshot;
                        this.status = '';
                        this.statusKind = '';
                    } catch {
                        this.status = 'Could not load AI settings.';
                        this.statusKind = 'error';
                    }
                },

                reset() {
                    this.load();
                },

                async refreshLmstudio() {
                    if (this.lmstudioRefreshing) return;
                    this.lmstudioRefreshing = true;
                    this.lmstudioModelsHint = 'Loading models from LM Studio…';
                    try {
                        const url = this.lmstudio.url.trim();
                        const qs = url ? `?url=${encodeURIComponent(url)}` : '';
                        const r = await apiFetch(`/api/ai/lmstudio/models${qs}`);
                        const data = await r.json();
                        if (!data.ok) {
                            this.lmstudioModels = this._ensureModelOption([], this.lmstudio.model);
                            this.lmstudioModelsHint = data.error || 'LM Studio unreachable.';
                            return;
                        }
                        const models = Array.isArray(data.models) ? data.models : [];
                        this.lmstudioModels = this._ensureModelOption(models, this.lmstudio.model);
                        const n = models.length;
                        this.lmstudioModelsHint = n
                            ? `Found ${n} model${n === 1 ? '' : 's'} on ${data.url}. Pick one and click Save AI settings.`
                            : `Connected to ${data.url} but no models are loaded. Load a model in LM Studio, then click Refresh.`;
                    } catch (e) {
                        this.lmstudioModelsHint = `Refresh failed: ${e.message}`;
                    } finally {
                        this.lmstudioRefreshing = false;
                    }
                },

                async refreshGemini() {
                    if (this.geminiRefreshing) return;
                    this.geminiRefreshing = true;
                    this.geminiModelsHint = 'Loading Gemini models…';
                    try {
                        const enteredKey = this.gemini.apiKey.trim();
                        const qs = enteredKey ? `?apiKey=${encodeURIComponent(enteredKey)}` : '';
                        const r = await apiFetch(`/api/ai/gemini/models${qs}`);
                        const data = await r.json();
                        const live = Array.isArray(data.models) && data.models.length;
                        const models = live ? data.models : DEFAULT_GEMINI_MODELS.slice();
                        this.geminiModels = this._ensureModelOption(models, this.gemini.model, '');
                        if (data.source === 'api') {
                            this.geminiModelsHint = `Loaded ${models.length} models live from Google.`;
                        } else if (data.error) {
                            this.geminiModelsHint = data.error;
                        } else {
                            this.geminiModelsHint = 'Showing common Gemini models. Save a key + click Refresh for the live list.';
                        }
                    } catch (e) {
                        this.geminiModelsHint = `Refresh failed: ${e.message}`;
                    } finally {
                        this.geminiRefreshing = false;
                    }
                },

                async save() {
                    if (!this.dirty || this.saving) return;
                    this.saving = true;
                    this.status = '';
                    this.statusKind = '';
                    const body = {
                        provider: this.effectiveProvider,
                        lmstudioUrl: this.lmstudio.url.trim(),
                        lmstudioModel: (this.lmstudio.model || '').trim(),
                        lmstudioTimeout: this.lmstudio.timeout,
                        lmstudioMaxTokens: this.lmstudio.maxTokens,
                        geminiModel: (this.gemini.model || '').trim(),
                        geminiApiKey: this.gemini.apiKey,
                        openaiBaseUrl: this.openai.baseUrl.trim(),
                        openaiModel: this.openai.model.trim(),
                        openaiApiKey: this.openai.apiKey
                    };
                    const fb = this.fallbackProviders.trim();
                    if (fb) body.fallbackProviders = fb;
                    try {
                        const r = await apiFetch('/api/settings/ai', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        });
                        const data = await r.json();
                        if (!r.ok) throw new Error(data.error || 'Save failed');
                        await this.load();
                        this.status = data.message || 'Saved.';
                        this.statusKind = 'success';
                        if (typeof refreshSystemInfo === 'function') {
                            await refreshSystemInfo();
                        }
                    } catch (e) {
                        this.status = e.message;
                        this.statusKind = 'error';
                    } finally {
                        this.saving = false;
                    }
                }
            };
        }

        // Alpine.js component — Moderation / YouTube enforcement card.
        // Computes the enforcement banner from the same toggles that drive
        // the save payload, so the banner is always in sync with the form.
        function moderationCard() {
            return {
                loaded: false,
                saving: false,
                status: '',
                statusKind: '',
                enabled: true,
                strictness: 'medium',
                responses: { warning: '', timeout: '', ban: '' },
                autoRespond: true,
                autoTimeout: false,
                autoBan: false,
                timeoutSeconds: 300,
                initialSnapshot: '',

                get currentSnapshot() {
                    return JSON.stringify({
                        enabled: this.enabled,
                        strictness: this.strictness,
                        responses: { ...this.responses },
                        autoRespond: this.autoRespond,
                        autoTimeout: this.autoTimeout,
                        autoBan: this.autoBan,
                        timeoutSeconds: Number(this.timeoutSeconds) || 0
                    });
                },
                get dirty() {
                    return this.loaded && this.currentSnapshot !== this.initialSnapshot;
                },
                get banner() {
                    const t = this.autoTimeout;
                    const b = this.autoBan;
                    const r = this.autoRespond;
                    if (t && b) {
                        return {
                            kind: 'success',
                            text: 'YouTube enforcement is ACTIVE — both timeout and ban will call the YouTube API on flagged messages.',
                            showEnableAll: false
                        };
                    }
                    if (!t && !b) {
                        return {
                            kind: 'warning',
                            text: r
                                ? 'YouTube enforcement is OFF. Bot will only post template messages — viewers will NOT be timed out or banned on YouTube. Audit log shows tier (warning/timeout/ban), not real action.'
                                : 'Moderation is silent: no chat replies, no YouTube actions. Toggle “Post chat messages” and/or the YouTube enforcement toggles below to actually enforce.',
                            showEnableAll: true
                        };
                    }
                    return {
                        kind: 'info',
                        text: `Partial enforcement: timeout ${t ? 'ON' : 'OFF'}, ban ${b ? 'ON' : 'OFF'}.`,
                        showEnableAll: false
                    };
                },

                async init() {
                    await this.load();
                },

                async load() {
                    try {
                        const r = await apiFetch('/api/settings/moderation');
                        if (!r.ok) throw new Error('Load failed');
                        const s = await r.json();
                        this.enabled = s.enabled !== false;
                        this.strictness = s.strictness || 'medium';
                        this.responses.warning = (s.responses && s.responses.warning) || '';
                        this.responses.timeout = (s.responses && s.responses.timeout) || '';
                        this.responses.ban = (s.responses && s.responses.ban) || '';
                        this.autoRespond = s.autoRespond !== false;
                        this.autoTimeout = s.autoTimeout === true;
                        this.autoBan = s.autoBan === true;
                        this.timeoutSeconds = s.timeoutSeconds ?? 300;
                        this.loaded = true;
                        this.initialSnapshot = this.currentSnapshot;
                        this.status = '';
                        this.statusKind = '';
                    } catch {
                        this.status = 'Could not load moderation settings.';
                        this.statusKind = 'error';
                    }
                },

                reset() {
                    this.load();
                },

                async enableAll() {
                    this.autoTimeout = true;
                    this.autoBan = true;
                    this.autoRespond = true;
                    await this.save();
                },

                async save() {
                    if (!this.dirty || this.saving) return;
                    this.saving = true;
                    this.status = '';
                    this.statusKind = '';
                    try {
                        const r = await apiFetch('/api/settings/moderation', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                enabled: this.enabled,
                                strictness: this.strictness,
                                responses: { ...this.responses },
                                autoRespond: this.autoRespond,
                                autoTimeout: this.autoTimeout,
                                autoBan: this.autoBan,
                                timeoutSeconds: this.timeoutSeconds
                            })
                        });
                        const data = await r.json();
                        if (!r.ok) throw new Error(data.error || 'Save failed');
                        await this.load();
                        this.status = data.message || 'Saved.';
                        this.statusKind = 'success';
                    } catch (e) {
                        this.status = e.message;
                        this.statusKind = 'error';
                    } finally {
                        this.saving = false;
                    }
                }
            };
        }

        // Alpine.js component — Google OAuth card.
        // Reactive state replaces the old fetch+DOM helpers; the Save button is
        // disabled until the user actually changes something (dirty tracking).
        function oauthCard() {
            return {
                redirectUri: '',
                clientId: '',
                clientSecret: '',
                initialClientId: '',
                hasStoredSecret: false,
                saving: false,
                status: '',
                statusKind: '', // '', 'error', 'success'
                /** 'safe' | 'plain' | null — never use x-html for paths (XSS). */
                secretsMode: null,
                secretsPathDisplay: '',

                get canSave() {
                    return this.clientId.trim() !== '' && this.clientSecret.trim() !== '';
                },
                get dirty() {
                    return (
                        this.clientId.trim() !== this.initialClientId ||
                        this.clientSecret.length > 0
                    );
                },

                async init() {
                    await this.load();
                },

                async load() {
                    try {
                        const r = await apiFetch('/api/settings/oauth');
                        const o = await r.json();
                        this.redirectUri = o.redirectUri || '';
                        this.clientId = o.clientId || '';
                        this.initialClientId = (o.clientId || '').trim();
                        this.hasStoredSecret = !!o.hasClientSecret;
                        this.clientSecret = '';
                    } catch {
                        this.status = 'Could not load settings.';
                        this.statusKind = 'error';
                    }
                    await this.loadSecretsNote();
                },

                async loadSecretsNote() {
                    try {
                        const r = await apiFetch('/api/system/secrets');
                        const s = await r.json();
                        this.secretsPathDisplay = String(s.filePath || '');
                        this.secretsMode = s.mode === 'safe' ? 'safe' : 'plain';
                    } catch {
                        this.secretsMode = null;
                        this.secretsPathDisplay = '';
                    }
                },

                reset() {
                    this.clientId = this.initialClientId;
                    this.clientSecret = '';
                    this.status = '';
                    this.statusKind = '';
                },

                copyRedirectUri() {
                    if (!this.redirectUri) return;
                    navigator.clipboard.writeText(this.redirectUri).then(() => {
                        this.status = 'Redirect URI copied.';
                        this.statusKind = 'success';
                        setTimeout(() => {
                            if (this.status === 'Redirect URI copied.') {
                                this.status = '';
                                this.statusKind = '';
                            }
                        }, 2000);
                    });
                },

                async save() {
                    if (!this.canSave || !this.dirty || this.saving) return;
                    this.saving = true;
                    this.status = '';
                    this.statusKind = '';
                    try {
                        const r = await apiFetch('/api/settings/oauth', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                clientId: this.clientId.trim(),
                                clientSecret: this.clientSecret
                            })
                        });
                        const data = await r.json();
                        if (!r.ok) throw new Error(data.error || 'Save failed');
                        this.initialClientId = this.clientId.trim();
                        this.clientSecret = '';
                        this.hasStoredSecret = true;
                        this.status = data.message || 'Saved.';
                        this.statusKind = 'success';
                        if (typeof refreshAuthBanner === 'function') {
                            await refreshAuthBanner();
                        }
                    } catch (e) {
                        this.status = e.message;
                        this.statusKind = 'error';
                    } finally {
                        this.saving = false;
                    }
                }
            };
        }

        /** Replace inline onclick (blocked by strict CSP) with delegated handlers. */
        function bindDelegatedClicks() {
            if (document.body.dataset.ssDelegatedBound === '1') return;
            document.body.dataset.ssDelegatedBound = '1';
            document.body.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-ss-action]');
                if (!btn) return;
                const action = btn.getAttribute('data-ss-action');
                if (!action) return;
                switch (action) {
                    case 'switch-tab':
                        switchTab(btn.getAttribute('data-ss-tab') || 'monitor');
                        break;
                    case 'google-signin':
                        googleSignIn();
                        break;
                    case 'test-connection':
                        testConnection();
                        break;
                    case 'toggle-monitoring':
                        toggleMonitoring();
                        break;
                    case 'clear-logs':
                        clearLogs();
                        break;
                    case 'load-moderation-actions':
                        loadModerationActions();
                        break;
                    case 'refresh-system-info':
                        refreshSystemInfo();
                        break;
                    case 'export-data':
                        exportData(btn.getAttribute('data-ss-format') || 'json');
                        break;
                    case 'load-raw-messages':
                        loadRawMessages();
                        break;
                    case 'test-ai':
                        testAI();
                        break;
                    default:
                        break;
                }
            });
        }

        window.addEventListener('load', () => {
            bindDelegatedClicks();
            initElectronTitlebar();
            initThemeSelect();
            addLog('SafeStream ready', 'success');
            refreshSystemInfo();
            refreshAuthBanner();
            // OAuth, AI moderation, and Moderation cards self-load via Alpine x-init="init()".
            apiFetch('/api/smart-stats')
                .then((r) => r.json())
                .then((stats) => {
                    applyStats(stats);
                    if (stats && stats.isRunning) {
                        isMonitoring = true;
                        const btn = document.getElementById('monitorBtn');
                        if (btn) {
                            btn.textContent = 'Stop monitoring';
                            btn.classList.remove('btn-primary');
                            btn.classList.add('btn-error');
                        }
                        updateStatus('active');
                    }
                })
                .catch(() => {});
            apiFetch('/api/comments/recent?limit=200')
                .then((r) => r.json())
                .then((data) => {
                    (data?.comments || []).forEach(addComment);
                })
                .catch(() => {});
            startStatsUpdates();
            const auth = new URLSearchParams(window.location.search).get('auth');
            if (auth === 'success') addLog('Google sign-in completed', 'success');
            if (auth === 'error') addLog('Google sign-in failed — try Sign in again', 'error');
        });
