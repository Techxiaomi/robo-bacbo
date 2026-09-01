'use strict';

(() => {
    const STATE = {
        installed: false,
        saveInProgress: false,
        selectedIds: new Set(),
        eligibleAccounts: [],
        originalFetch: null,
        originalOpen: null,
        originalEdit: null,
        originalSave: null
    };

    function currentTableKey() {
        const mesa = window.__mesaSwitcher?.detectarMesaAtual?.();
        return String(mesa?.codigo || '').trim().toLowerCase();
    }

    function normalizedAccountIds(values) {
        const source = Array.isArray(values) ? values : [];
        return Array.from(new Set(source
            .map(Number)
            .filter(id => Number.isSafeInteger(id) && id > 0)))
            .sort((a, b) => a - b);
    }

    function selectedAccountIds() {
        return normalizedAccountIds(Array.from(STATE.selectedIds));
    }

    function selectedSummary() {
        const ids = selectedAccountIds();
        if (ids.length === 0) return 'Selecionar conta(s)';
        if (ids.length === 1) {
            const account = STATE.eligibleAccounts.find(item => item.id === ids[0]);
            return account ? `Conta ${account.id} — ${account.name}` : `Conta ${ids[0]}`;
        }
        return `${ids.length} contas selecionadas`;
    }

    function updateSelectorSummary() {
        const root = document.getElementById('at-account-bindings');
        if (!root) return;
        const summary = root.querySelector('[data-at-account-summary]');
        const badge = root.querySelector('[data-at-account-count]');
        if (summary) summary.textContent = selectedSummary();
        if (badge) badge.textContent = String(STATE.selectedIds.size);
    }

    function setSelected(ids) {
        STATE.selectedIds = new Set(normalizedAccountIds(ids));
        const root = document.getElementById('at-account-bindings');
        if (root) {
            for (const input of root.querySelectorAll('input[data-at-account-id]')) {
                input.checked = STATE.selectedIds.has(Number(input.dataset.atAccountId));
            }
        }
        updateSelectorSummary();
    }

    async function loadEligibleAccounts() {
        const tableKey = currentTableKey();
        if (!tableKey) throw new Error('TRADER_ACCOUNT_UI_TABLE_UNRESOLVED');

        const response = await STATE.originalFetch('/api/trader-account-catalog', {
            cache: 'no-store',
            credentials: 'same-origin'
        });
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok || payload?.success !== true) {
            const detail = String(payload?.error || `HTTP_${response.status}`);
            throw new Error(`TRADER_ACCOUNT_UI_CATALOG_${detail}`);
        }

        const responseTable = String(payload.table_code || '').trim().toLowerCase();
        if (responseTable !== tableKey) {
            throw new Error(`TRADER_ACCOUNT_UI_CATALOG_TABLE_MISMATCH:${responseTable || '<empty>'}`);
        }

        const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
        STATE.eligibleAccounts = accounts
            .map(account => Object.freeze({
                id: Number(account.account_id),
                name: String(account.account_name || `Conta ${account.account_id}`),
                tableName: String(account.table_name || account.table_key || tableKey)
            }))
            .filter(item => Number.isSafeInteger(item.id) && item.id > 0)
            .sort((a, b) => a.id - b.id);

        return STATE.eligibleAccounts;
    }

    async function loadTrader(id) {
        const response = await STATE.originalFetch('/api/auto-traders', {
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`TRADER_ACCOUNT_UI_TRADERS_HTTP_${response.status}`);
        const traders = await response.json();
        if (!Array.isArray(traders)) throw new Error('TRADER_ACCOUNT_UI_TRADERS_INVALID');
        return traders.find(item => Number(item?.id) === Number(id)) || null;
    }

    function ensureContainer() {
        let root = document.getElementById('at-account-bindings');
        if (root) return root;

        const nome = document.getElementById('at-nome');
        const formGroup = nome?.closest('.form-group');
        if (!formGroup?.parentElement) return null;

        root = document.createElement('div');
        root.id = 'at-account-bindings';
        root.className = 'form-group';
        root.style.cssText = 'flex:2; min-width:280px; position:relative;';
        root.innerHTML = `
            <label style="color:#8ec5ff; display:block; margin-bottom:5px;">Conta(s) de Operação *</label>
            <button type="button" data-at-account-toggle
                style="width:100%; min-height:38px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid #3f5264; border-radius:6px; background:#111; color:#ddd; cursor:pointer; text-align:left;">
                <span data-at-account-summary style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Selecionar conta(s)</span>
                <span style="display:flex; align-items:center; gap:7px; flex:none;">
                    <span data-at-account-count style="min-width:20px; height:20px; padding:0 6px; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; background:#0d6efd; color:#fff; font-size:11px; font-weight:700;">0</span>
                    <span data-at-account-chevron style="font-size:11px; color:#8ec5ff;">▼</span>
                </span>
            </button>
            <div data-at-account-dropdown hidden
                style="position:absolute; z-index:1000; left:0; right:0; top:calc(100% - 2px); margin-top:4px; padding:9px; border:1px solid #3f5264; border-radius:6px; background:#111; box-shadow:0 10px 24px rgba(0,0,0,.45);">
                <input type="search" data-at-account-search placeholder="Buscar por conta ou nome..."
                    style="width:100%; box-sizing:border-box; margin-bottom:8px; padding:8px 9px; border:1px solid #333; border-radius:5px; background:#181818; color:#eee; outline:none;">
                <div data-at-account-list style="display:flex; flex-direction:column; gap:5px; max-height:210px; overflow-y:auto; padding-right:2px;"></div>
                <small style="display:block; color:#777; margin-top:7px; line-height:1.3;">
                    Apenas contas habilitadas para a mesa atual são exibidas.
                </small>
            </div>
        `;
        formGroup.insertAdjacentElement('afterend', root);

        const toggle = root.querySelector('[data-at-account-toggle]');
        const dropdown = root.querySelector('[data-at-account-dropdown]');
        const chevron = root.querySelector('[data-at-account-chevron]');
        const search = root.querySelector('[data-at-account-search]');

        toggle?.addEventListener('click', () => {
            const opening = dropdown?.hidden === true;
            if (dropdown) dropdown.hidden = !opening;
            if (chevron) chevron.textContent = opening ? '▲' : '▼';
            if (opening && search) {
                search.value = '';
                filterRenderedAccounts('');
                setTimeout(() => search.focus(), 0);
            }
        });

        search?.addEventListener('input', () => filterRenderedAccounts(search.value));

        document.addEventListener('click', event => {
            if (!root.isConnected || root.contains(event.target)) return;
            if (dropdown) dropdown.hidden = true;
            if (chevron) chevron.textContent = '▼';
        });

        return root;
    }

    function filterRenderedAccounts(term) {
        const root = document.getElementById('at-account-bindings');
        if (!root) return;
        const normalized = String(term || '').trim().toLocaleLowerCase('pt-BR');
        let visible = 0;
        for (const row of root.querySelectorAll('[data-at-account-row]')) {
            const haystack = String(row.dataset.searchText || '').toLocaleLowerCase('pt-BR');
            const match = !normalized || haystack.includes(normalized);
            row.hidden = !match;
            if (match) visible += 1;
        }
        const empty = root.querySelector('[data-at-account-empty-search]');
        if (empty) empty.hidden = visible !== 0;
    }

    function renderAccounts() {
        const root = ensureContainer();
        if (!root) return false;
        const list = root.querySelector('[data-at-account-list]');
        if (!list) return false;

        if (STATE.eligibleAccounts.length === 0) {
            list.innerHTML = '<div style="color:#dc3545; font-size:12px; padding:7px;">Nenhuma conta habilitada possui esta mesa configurada.</div>';
            updateSelectorSummary();
            return true;
        }

        const rows = STATE.eligibleAccounts.map(account => {
            const label = document.createElement('label');
            label.dataset.atAccountRow = '1';
            label.dataset.searchText = `conta ${account.id} ${account.name} ${account.tableName}`;
            label.style.cssText = 'display:flex; align-items:center; gap:9px; padding:7px 9px; border:1px solid #2d2d2d; border-radius:5px; background:#181818; cursor:pointer; text-transform:none; letter-spacing:0; font-size:12px; color:#ddd;';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.atAccountId = String(account.id);
            input.checked = STATE.selectedIds.has(account.id);
            input.addEventListener('change', () => {
                if (input.checked) STATE.selectedIds.add(account.id);
                else STATE.selectedIds.delete(account.id);
                updateSelectorSummary();
            });

            const text = document.createElement('span');
            text.style.cssText = 'min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            text.textContent = `Conta ${account.id} — ${account.name} · ${account.tableName}`;
            label.append(input, text);
            return label;
        });

        const emptySearch = document.createElement('div');
        emptySearch.dataset.atAccountEmptySearch = '1';
        emptySearch.hidden = true;
        emptySearch.style.cssText = 'color:#888; font-size:12px; padding:8px; text-align:center;';
        emptySearch.textContent = 'Nenhuma conta encontrada para esta busca.';

        list.replaceChildren(...rows, emptySearch);
        updateSelectorSummary();
        return true;
    }

    async function prepareAccounts(ids) {
        setSelected(ids);
        try {
            await loadEligibleAccounts();
            renderAccounts();
            setSelected(ids);
        } catch (error) {
            console.error('Falha ao carregar contas do Auto-Trader:', error);
            const root = ensureContainer();
            const list = root?.querySelector('[data-at-account-list]');
            if (list) {
                list.innerHTML = `<div style="color:#dc3545; font-size:12px; padding:7px;">Falha ao carregar contas disponíveis (${String(error?.message || 'erro desconhecido')}). Não salve o Trader até corrigir.</div>`;
            }
        }
    }

    function installFetchInterceptor() {
        if (STATE.originalFetch) return;
        STATE.originalFetch = window.fetch.bind(window);
        window.fetch = async function(input, init) {
            if (!STATE.saveInProgress || !init || typeof init.body !== 'string') {
                return STATE.originalFetch(input, init);
            }

            let pathname = '';
            try {
                pathname = new URL(typeof input === 'string' ? input : input?.url || '', window.location.href).pathname;
            } catch (_) {}
            const method = String(init.method || 'GET').toUpperCase();
            const isTraderSave = (
                (method === 'POST' && pathname === '/api/auto-trader') ||
                (method === 'PUT' && /^\/api\/auto-trader\/\d+$/.test(pathname))
            );
            if (!isTraderSave) return STATE.originalFetch(input, init);

            let body;
            try { body = JSON.parse(init.body); }
            catch (_) { return STATE.originalFetch(input, init); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return STATE.originalFetch(input, init);
            }

            body.config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
                ? { ...body.config }
                : {};
            body.config.account_ids = selectedAccountIds();
            return STATE.originalFetch(input, { ...init, body: JSON.stringify(body) });
        };
    }

    function installFunctionWrappers() {
        if (typeof window.abrirFormularioAutoTrader === 'function' && !STATE.originalOpen) {
            STATE.originalOpen = window.abrirFormularioAutoTrader;
            window.abrirFormularioAutoTrader = async function(...args) {
                const result = await STATE.originalOpen.apply(this, args);
                await prepareAccounts([]);
                return result;
            };
        }

        if (typeof window.prepararEdicaoAutoTrader === 'function' && !STATE.originalEdit) {
            STATE.originalEdit = window.prepararEdicaoAutoTrader;
            window.prepararEdicaoAutoTrader = async function(id, ...args) {
                const result = await STATE.originalEdit.call(this, id, ...args);
                try {
                    const trader = await loadTrader(id);
                    await prepareAccounts(trader?.config?.account_ids || []);
                } catch (error) {
                    console.error('Falha ao carregar vínculo do Auto-Trader em edição:', error);
                    await prepareAccounts([]);
                }
                return result;
            };
        }

        if (typeof window.salvarAutoTrader === 'function' && !STATE.originalSave) {
            STATE.originalSave = window.salvarAutoTrader;
            window.salvarAutoTrader = async function(...args) {
                const ids = selectedAccountIds();
                if (ids.length === 0) {
                    window.alert('Selecione ao menos uma Conta de Operação para este Auto-Trader.');
                    return false;
                }
                STATE.saveInProgress = true;
                try {
                    return await STATE.originalSave.apply(this, args);
                } finally {
                    STATE.saveInProgress = false;
                }
            };
        }
    }

    function install() {
        if (STATE.installed) return true;
        installFetchInterceptor();
        installFunctionWrappers();
        STATE.installed = true;
        window.__traderAccountBindingUiReady = true;
        return true;
    }

    window.__traderAccountBindingUi = Object.freeze({
        install,
        selectedAccountIds,
        prepareAccounts
    });
})();
