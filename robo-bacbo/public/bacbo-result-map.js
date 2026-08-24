(() => {
    'use strict';

    const ROWS = 6;
    const DEFAULT_LIMIT = 300;
    const LIMITS = [120, 300, 600, 1000];
    const MATCH_TOLERANCE_MS = 5000;
    const STORAGE_MODE = 'bacboMapMode';
    const STORAGE_LIMIT = 'bacboMapVisualLimit';
    const EVENTO_LIVE = 'bacbo_round_live';

    const state = {
        mode: localStorage.getItem(STORAGE_MODE) === 'numbers' ? 'numbers' : 'letters',
        limit: LIMITS.includes(Number(localStorage.getItem(STORAGE_LIMIT)))
            ? Number(localStorage.getItem(STORAGE_LIMIT))
            : DEFAULT_LIMIT,
        rows: [],
        canonical: [],
        knownUuids: new Set(),
        highlightByKey: new Map(),
        refreshTimer: null,
        refreshInFlight: false,
        refreshQueued: false,
        snapshotLoaded: false,
        needsResync: false,
        socket: null
    };

    function winner(valor) {
        const bruto = String(valor || '').trim().toUpperCase();
        if (bruto === 'PLAYER' || bruto === 'PLAYERWON' || bruto === 'P') return 'Player';
        if (bruto === 'BANKER' || bruto === 'BANKERWON' || bruto === 'B') return 'Banker';
        if (bruto === 'TIE' || bruto === 'TIEWON' || bruto === 'T') return 'Tie';
        return '';
    }

    function timestampMs(valor) {
        if (valor === null || valor === undefined || valor === '') return NaN;
        if (typeof valor === 'number' && Number.isFinite(valor)) return valor < 1e12 ? valor * 1000 : valor;
        const ms = Date.parse(String(valor));
        return Number.isFinite(ms) ? ms : NaN;
    }

    function chaveAnalitica(item, resultado, ms) {
        return `${item?.id ?? ''}|${resultado}|${item?.id_sessao ?? ''}|${Number.isFinite(ms) ? ms : ''}`;
    }

    function normalizarAnalitico(item) {
        if (!item || typeof item !== 'object') return null;
        const resultado = winner(item.resultado || item.winner || item.type);
        if (!resultado) return null;
        const dataHora = item.data_hora || item.instant || item.timestamp || null;
        const ms = timestampMs(dataHora);
        return {
            ...item,
            resultado,
            _ms: ms,
            _displayInstant: item.instant || item.data_hora || null,
            _sum: Number.isFinite(Number(item.resultado_soma))
                ? Number(item.resultado_soma)
                : (Number.isFinite(Number(item.result)) ? Number(item.result) : null),
            _uuid: String(item.uuid || item.round_uuid || '').trim(),
            _key: chaveAnalitica(item, resultado, ms)
        };
    }

    function normalizarCanonico(item) {
        if (!item || typeof item !== 'object') return null;
        const resultado = winner(item.winner || item.type || item.resultado);
        const soma = Number(item.result ?? item.resultado_soma);
        const ms = timestampMs(item.instant || item.data_hora || item.timestamp);
        const uuid = String(item.uuid || item.round_uuid || '').trim();
        if (!resultado || !Number.isFinite(soma) || !Number.isFinite(ms)) return null;
        return {
            uuid,
            resultado,
            soma,
            instant: new Date(ms).toISOString(),
            ms
        };
    }

    function canonicoComoVisual(item) {
        return {
            id: item.uuid ? `live-${item.uuid}` : `canonical-${item.ms}`,
            resultado: item.resultado,
            resultado_soma: item.soma,
            data_hora: item.instant,
            instant: item.instant,
            id_sessao: 'CANONICAL_VISUAL',
            _ms: item.ms,
            _displayInstant: item.instant,
            _sum: item.soma,
            _uuid: item.uuid,
            _key: item.uuid ? `uuid:${item.uuid}` : `canonical:${item.ms}|${item.resultado}|${item.soma}`
        };
    }

    function chaveGiro(item) {
        return item?._key || (item?._uuid ? `uuid:${item._uuid}` : chaveAnalitica(item, winner(item?.resultado), timestampMs(item?.data_hora)));
    }

    function chaveCanonica(item) {
        return item.uuid || `${item.instant}|${item.resultado}|${item.soma}`;
    }

    function mesclarCanonicos(novos) {
        const dedup = new Map();
        for (const item of [...state.canonical, ...(Array.isArray(novos) ? novos : [])]) {
            const normalizado = normalizarCanonico(item);
            if (!normalizado) continue;
            dedup.set(chaveCanonica(normalizado), normalizado);
        }
        state.canonical = [...dedup.values()].sort((a, b) => a.ms - b.ms).slice(-1000);
        state.knownUuids = new Set(state.canonical.map(item => item.uuid).filter(Boolean));
    }

    function indexarHighlights(dados, highlights) {
        state.highlightByKey.clear();
        if (!Array.isArray(dados) || !Array.isArray(highlights)) return;
        for (const item of highlights) {
            const indice = Number(item?.index);
            if (!Number.isInteger(indice) || indice < 0 || indice >= dados.length) continue;
            const status = String(item?.status || '').toLowerCase();
            if (status !== 'win' && status !== 'loss') continue;
            const normalizado = normalizarAnalitico(dados[indice]);
            if (normalizado) state.highlightByKey.set(normalizado._key, status);
        }
    }

    function mesclarAnaliticoECanonico(dados) {
        const analiticos = (Array.isArray(dados) ? dados : []).map(normalizarAnalitico).filter(Boolean);
        if (state.canonical.length === 0) return analiticos;
        if (analiticos.length === 0) return state.canonical.map(canonicoComoVisual);

        const usados = new Set();
        for (const giro of analiticos) {
            if (!Number.isFinite(giro._ms)) continue;
            let melhor = -1;
            let melhorDist = Number.POSITIVE_INFINITY;

            for (let i = 0; i < state.canonical.length; i++) {
                if (usados.has(i)) continue;
                const can = state.canonical[i];
                if (can.resultado !== giro.resultado) continue;
                const dist = Math.abs(can.ms - giro._ms);
                if (dist <= MATCH_TOLERANCE_MS && dist < melhorDist) {
                    melhor = i;
                    melhorDist = dist;
                }
            }

            if (melhor >= 0) {
                const can = state.canonical[melhor];
                usados.add(melhor);
                giro._sum = can.soma;
                giro._displayInstant = can.instant;
                giro._uuid = can.uuid;
            }
        }

        const tempos = analiticos.map(item => item._ms).filter(Number.isFinite);
        const ultimoAnalitico = tempos.length > 0 ? Math.max(...tempos) : Number.NEGATIVE_INFINITY;
        const cauda = [];
        for (let i = 0; i < state.canonical.length; i++) {
            if (usados.has(i)) continue;
            const can = state.canonical[i];
            if (can.ms > ultimoAnalitico + MATCH_TOLERANCE_MS) cauda.push(canonicoComoVisual(can));
        }

        return [...analiticos, ...cauda].sort((a, b) => {
            const ams = Number.isFinite(a._ms) ? a._ms : 0;
            const bms = Number.isFinite(b._ms) ? b._ms : 0;
            return ams - bms;
        });
    }

    function injetarCss() {
        if (document.getElementById('bacbo-result-map-style')) return;
        const style = document.createElement('style');
        style.id = 'bacbo-result-map-style';
        style.textContent = `
            #bk-fita-historico.bacbo-map-root { display:block; padding:0; background:#111; border:1px solid #2b2b2b; border-radius:8px; overflow:hidden; }
            .bacbo-map-toolbar { min-height:42px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-bottom:1px solid #2b2b2b; background:#171717; flex-wrap:wrap; }
            .bacbo-map-title { font-size:12px; font-weight:700; letter-spacing:.2px; color:#e8e8e8; display:flex; align-items:center; gap:7px; }
            .bacbo-map-live-dot { width:7px; height:7px; border-radius:50%; background:#28a745; box-shadow:0 0 7px rgba(40,167,69,.85); }
            .bacbo-map-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .bacbo-map-segment { display:inline-flex; padding:2px; border:1px solid #383838; background:#0f0f0f; border-radius:6px; }
            .bacbo-map-mode { border:0; background:transparent; color:#888; height:26px; padding:0 9px; border-radius:4px; font:600 11px/1 'Segoe UI',sans-serif; cursor:pointer; }
            .bacbo-map-mode.active { background:#2a2a2a; color:#fff; }
            .bacbo-map-limit-label { display:flex; align-items:center; gap:6px; color:#888; font-size:11px; }
            .bacbo-map-limit { width:auto; min-width:76px; height:30px; padding:3px 7px; font-size:11px; background:#111; }
            .bacbo-map-scroll { overflow-x:auto; overflow-y:hidden; padding:9px 10px 10px; scrollbar-width:thin; scrollbar-color:#444 #171717; }
            .bacbo-map-scroll::-webkit-scrollbar { height:7px; }
            .bacbo-map-scroll::-webkit-scrollbar-track { background:#171717; }
            .bacbo-map-scroll::-webkit-scrollbar-thumb { background:#444; border-radius:5px; }
            .bacbo-map-grid { display:grid; grid-template-rows:repeat(${ROWS}, 28px); grid-auto-flow:column; grid-auto-columns:28px; gap:3px; width:max-content; min-height:${ROWS * 28 + (ROWS - 1) * 3}px; }
            .bacbo-map-cell { width:28px; height:28px; border-radius:50%; border:2px solid rgba(255,255,255,.78); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; line-height:1; color:#fff; user-select:none; cursor:default; box-shadow:0 1px 3px rgba(0,0,0,.35); transition:transform .12s ease, box-shadow .12s ease; position:relative; }
            .bacbo-map-cell.player { background:#1769d2; }
            .bacbo-map-cell.banker { background:#d83b34; }
            .bacbo-map-cell.tie { background:#c88718; color:#fff; }
            .bacbo-map-cell:hover, .bacbo-map-cell:focus-visible { transform:scale(1.12); z-index:3; outline:none; box-shadow:0 0 0 2px #fff, 0 4px 10px rgba(0,0,0,.45); }
            .bacbo-map-cell.map-win { box-shadow:0 0 0 2px #31c96b, 0 0 9px rgba(49,201,107,.8); }
            .bacbo-map-cell.map-loss { box-shadow:0 0 0 2px #ff4d57, 0 0 9px rgba(255,77,87,.85); }
            .bacbo-map-cell.map-live-new { animation:bacboMapEntrada .22s ease-out; }
            @keyframes bacboMapEntrada { from { transform:scale(.55); opacity:.35; } to { transform:scale(1); opacity:1; } }
            .bacbo-map-empty { color:#666; font-size:12px; padding:18px 4px; }
            .bacbo-map-tooltip { position:fixed; z-index:10000; pointer-events:none; display:none; padding:7px 10px; border:1px solid #4a4a4a; border-radius:5px; background:rgba(12,12,12,.96); color:#fff; font-size:12px; font-weight:600; white-space:nowrap; box-shadow:0 6px 18px rgba(0,0,0,.45); }
            @media (max-width:700px) {
                .bacbo-map-toolbar { align-items:flex-start; }
                .bacbo-map-controls { width:100%; justify-content:space-between; }
                .bacbo-map-grid { grid-template-rows:repeat(${ROWS}, 26px); grid-auto-columns:26px; gap:3px; }
                .bacbo-map-cell { width:26px; height:26px; font-size:10px; }
            }
        `;
        document.head.appendChild(style);
    }

    function ensureLayout() {
        injetarCss();
        const root = document.getElementById('bk-fita-historico');
        if (!root) return null;
        if (root.dataset.bacboMapReady === '1') return root;

        root.dataset.bacboMapReady = '1';
        root.classList.remove('bk-fita');
        root.classList.add('bacbo-map-root');
        root.innerHTML = `
            <div class="bacbo-map-toolbar">
                <div class="bacbo-map-title"><span>▦</span><span>Mapa Bac Bo</span><span class="bacbo-map-live-dot" title="Atualização live"></span></div>
                <div class="bacbo-map-controls">
                    <div class="bacbo-map-segment" role="group" aria-label="Modo do mapa">
                        <button type="button" class="bacbo-map-mode" data-mode="letters">P/B/T</button>
                        <button type="button" class="bacbo-map-mode" data-mode="numbers">1–12</button>
                    </div>
                    <label class="bacbo-map-limit-label">Últimos
                        <select class="bacbo-map-limit" aria-label="Quantidade de resultados visíveis">
                            ${LIMITS.map(limite => `<option value="${limite}">${limite}</option>`).join('')}
                        </select>
                    </label>
                </div>
            </div>
            <div class="bacbo-map-scroll">
                <div class="bacbo-map-grid" role="grid" aria-label="Resultados Bac Bo"></div>
            </div>
        `;

        let tooltip = document.getElementById('bacbo-map-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'bacbo-map-tooltip';
            tooltip.id = 'bacbo-map-tooltip';
            document.body.appendChild(tooltip);
        }

        root.querySelectorAll('.bacbo-map-mode').forEach(button => {
            button.addEventListener('click', () => {
                state.mode = button.dataset.mode === 'numbers' ? 'numbers' : 'letters';
                localStorage.setItem(STORAGE_MODE, state.mode);
                renderCurrent(false);
            });
        });

        const select = root.querySelector('.bacbo-map-limit');
        select.value = String(state.limit);
        select.addEventListener('change', () => {
            const limite = Number(select.value);
            if (!LIMITS.includes(limite)) return;
            state.limit = limite;
            localStorage.setItem(STORAGE_LIMIT, String(limite));
            scheduleRealtimeRefresh(0);
        });

        atualizarControles();
        return root;
    }

    function atualizarControles() {
        const root = document.getElementById('bk-fita-historico');
        if (!root) return;
        root.querySelectorAll('.bacbo-map-mode').forEach(button => {
            button.classList.toggle('active', button.dataset.mode === state.mode);
            button.setAttribute('aria-pressed', button.dataset.mode === state.mode ? 'true' : 'false');
        });
        const select = root.querySelector('.bacbo-map-limit');
        if (select) select.value = String(state.limit);
    }

    const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    function hora(item) {
        const ms = timestampMs(item?._displayInstant || item?.instant || item?.data_hora);
        return Number.isFinite(ms) ? timeFormatter.format(new Date(ms)) : '--:--:--';
    }

    function textoResultado(resultado) {
        if (resultado === 'Player') return 'PLAYER';
        if (resultado === 'Banker') return 'BANKER';
        return 'EMPATE';
    }

    function letraResultado(resultado) {
        if (resultado === 'Player') return 'P';
        if (resultado === 'Banker') return 'B';
        return 'T';
    }

    function showTooltip(event, item) {
        const tooltip = document.getElementById('bacbo-map-tooltip');
        if (!tooltip) return;
        const soma = Number.isFinite(Number(item?._sum)) ? String(Number(item._sum)) : 'N/D';
        tooltip.textContent = `${textoResultado(item.resultado)} - ${soma} - ${hora(item)}`;
        tooltip.style.display = 'block';
        moveTooltip(event);
    }

    function moveTooltip(event) {
        const tooltip = document.getElementById('bacbo-map-tooltip');
        if (!tooltip || tooltip.style.display !== 'block') return;
        const xBase = Number(event?.clientX);
        const yBase = Number(event?.clientY);
        if (!Number.isFinite(xBase) || !Number.isFinite(yBase)) return;
        const margem = 12;
        let left = xBase + 14;
        let top = yBase + 14;
        const rect = tooltip.getBoundingClientRect();
        if (left + rect.width + margem > window.innerWidth) left = xBase - rect.width - 14;
        if (top + rect.height + margem > window.innerHeight) top = yBase - rect.height - 14;
        tooltip.style.left = `${Math.max(margem, left)}px`;
        tooltip.style.top = `${Math.max(margem, top)}px`;
    }

    function hideTooltip() {
        const tooltip = document.getElementById('bacbo-map-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }

    function criarCelula(item, { live = false } = {}) {
        const cell = document.createElement('div');
        cell.className = `bacbo-map-cell ${item.resultado.toLowerCase()}`;
        if (live) cell.classList.add('map-live-new');
        cell.tabIndex = 0;
        cell.setAttribute('role', 'gridcell');
        if (item._uuid) cell.dataset.uuid = item._uuid;
        if (Number.isFinite(item._ms)) cell.dataset.ms = String(item._ms);

        const status = state.highlightByKey.get(chaveGiro(item));
        if (status === 'win') cell.classList.add('map-win');
        if (status === 'loss') cell.classList.add('map-loss');

        cell.textContent = state.mode === 'numbers'
            ? (Number.isFinite(Number(item._sum)) ? String(Number(item._sum)) : '—')
            : letraResultado(item.resultado);

        cell.addEventListener('mouseenter', event => showTooltip(event, item));
        cell.addEventListener('mousemove', moveTooltip);
        cell.addEventListener('mouseleave', hideTooltip);
        cell.addEventListener('focus', () => {
            const rect = cell.getBoundingClientRect();
            showTooltip({ clientX: rect.right, clientY: rect.top }, item);
        });
        cell.addEventListener('blur', hideTooltip);
        cell.addEventListener('click', event => {
            showTooltip(event, item);
            event.stopPropagation();
        });
        return cell;
    }

    function renderCurrent(scrollEnd) {
        const root = ensureLayout();
        if (!root) return false;
        atualizarControles();
        const grid = root.querySelector('.bacbo-map-grid');
        if (!grid) return false;

        const exibir = mesclarAnaliticoECanonico(state.rows).slice(-state.limit);
        grid.innerHTML = '';

        if (exibir.length === 0) {
            grid.innerHTML = '<div class="bacbo-map-empty">Nenhum resultado disponível.</div>';
            return true;
        }

        const fragment = document.createDocumentFragment();
        for (const item of exibir) fragment.appendChild(criarCelula(item));
        grid.appendChild(fragment);

        if (scrollEnd !== false) {
            const scroller = root.querySelector('.bacbo-map-scroll');
            if (scroller) requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
        }
        return true;
    }

    function appendLiveCell(round) {
        if (!document.getElementById('aba-backtest')?.classList.contains('visivel')) return false;
        const root = ensureLayout();
        const grid = root?.querySelector('.bacbo-map-grid');
        if (!grid) return false;

        if (round.uuid && grid.querySelector(`[data-uuid="${CSS.escape(round.uuid)}"]`)) return true;

        const item = canonicoComoVisual(round);
        const cells = grid.querySelectorAll('.bacbo-map-cell');
        const ultima = cells.length > 0 ? cells[cells.length - 1] : null;
        const ultimoMs = Number(ultima?.dataset?.ms);
        if (Number.isFinite(ultimoMs) && item._ms < ultimoMs) {
            renderCurrent(true);
            return true;
        }

        const vazio = grid.querySelector('.bacbo-map-empty');
        if (vazio) vazio.remove();
        grid.appendChild(criarCelula(item, { live: true }));

        while (grid.querySelectorAll('.bacbo-map-cell').length > state.limit) {
            grid.querySelector('.bacbo-map-cell')?.remove();
        }

        const scroller = root.querySelector('.bacbo-map-scroll');
        if (scroller) requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
        return true;
    }

    async function carregarSnapshotCanonico() {
        try {
            const resposta = await fetch(`/bacbo-map-snapshot.json?_t=${Date.now()}`, {
                cache: 'no-store', credentials: 'same-origin'
            });
            if (!resposta.ok) return false;
            const corpo = await resposta.json();
            const lista = Array.isArray(corpo) ? corpo : (Array.isArray(corpo?.rows) ? corpo.rows : []);
            const normalizados = lista.map(normalizarCanonico).filter(Boolean);
            mesclarCanonicos(normalizados);
            state.snapshotLoaded = true;
            return true;
        } catch (_) {
            return false;
        }
    }

    async function refreshRealtime() {
        if (state.refreshInFlight) {
            state.refreshQueued = true;
            return;
        }
        if (!document.getElementById('aba-backtest')?.classList.contains('visivel')) {
            state.needsResync = true;
            return;
        }

        state.refreshInFlight = true;
        try {
            const limite = Math.max(state.limit, 120);
            const [historico] = await Promise.all([
                fetch(`/api/historico-giros?limit=${limite}&_t=${Date.now()}`, {
                    cache: 'no-store', credentials: 'same-origin'
                }).then(async resposta => resposta.ok ? resposta.json() : []).catch(() => []),
                carregarSnapshotCanonico()
            ]);

            if (Array.isArray(historico) && historico.length > 0) state.rows = historico;
            state.needsResync = false;
            renderCurrent(true);
        } finally {
            state.refreshInFlight = false;
            if (state.refreshQueued) {
                state.refreshQueued = false;
                scheduleRealtimeRefresh(0);
            }
        }
    }

    function scheduleRealtimeRefresh(delay = 0) {
        clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => { void refreshRealtime(); }, Math.max(0, Number(delay) || 0));
    }

    function receberRoundLive(payload) {
        const round = normalizarCanonico(payload);
        if (!round || !round.uuid) return false;
        if (state.knownUuids.has(round.uuid)) return false;

        mesclarCanonicos([round]);
        appendLiveCell(round);
        return true;
    }

    function vincularSocket(socket) {
        if (!socket || typeof socket.on !== 'function') return false;
        if (socket.__bacboResultMapLiveBound === true) return true;

        try {
            Object.defineProperty(socket, '__bacboResultMapLiveBound', {
                value: true,
                enumerable: false,
                configurable: false
            });
        } catch (_) {
            socket.__bacboResultMapLiveBound = true;
        }

        state.socket = socket;
        let conectouUmaVez = socket.connected === true;

        socket.on(EVENTO_LIVE, receberRoundLive);
        socket.on('disconnect', () => {
            if (conectouUmaVez) state.needsResync = true;
        });
        socket.on('connect', () => {
            if (conectouUmaVez || state.needsResync) {
                state.needsResync = true;
                if (document.getElementById('aba-backtest')?.classList.contains('visivel')) {
                    scheduleRealtimeRefresh(0);
                }
            }
            conectouUmaVez = true;
        });
        return true;
    }

    function instalarBridgeDoClienteSocket() {
        const ioBase = window.io;
        if (typeof ioBase !== 'function') return false;
        if (ioBase.__bacboResultMapIoWrapped === true) return true;

        function ioComMapaLive(...args) {
            const socket = ioBase.apply(this, args);
            vincularSocket(socket);
            return socket;
        }

        try { Object.setPrototypeOf(ioComMapaLive, ioBase); } catch (_) {}
        Object.defineProperty(ioComMapaLive, '__bacboResultMapIoWrapped', {
            value: true,
            enumerable: false,
            configurable: false
        });
        window.io = ioComMapaLive;
        return true;
    }

    function render(dados, indicesHighlight) {
        const lista = Array.isArray(dados) ? dados : [];
        state.rows = lista;
        indexarHighlights(lista, Array.isArray(indicesHighlight) ? indicesHighlight : []);
        renderCurrent(true);

        if (!state.snapshotLoaded) {
            void carregarSnapshotCanonico().then(ok => {
                if (ok) renderCurrent(false);
            });
        } else if (state.needsResync) {
            scheduleRealtimeRefresh(0);
        }
        return true;
    }

    instalarBridgeDoClienteSocket();

    window.addEventListener('DOMContentLoaded', () => {
        ensureLayout();
        document.addEventListener('pointerdown', event => {
            if (!event.target.closest?.('.bacbo-map-cell')) hideTooltip();
        });
    });

    window.__bacboResultMap = {
        render,
        refreshRealtime,
        scheduleRealtimeRefresh,
        receberRoundLive
    };
})();
