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
        const root = document.getElementById('at-account-bindings');
        if (!root) return normalizedAccountIds(Array.from(STATE.selectedIds));
        return normalizedAccountIds(Array.from(
            root.querySelectorAll('input[data-at-account-id]:checked')
        ).map(input => input.dataset.atAccountId));
    }

    function setSelected(ids) {
        STATE.selectedIds = new Set(normalizedAccountIds(ids));
        const root = document.getElementById('at-account-bindings');
        if (!root) return;
        for (const input of root.querySelectorAll('input[data-at-account-id]')) {
            input.checked = STATE.selectedIds.has(Number(input.dataset.atAccountId));
        }
    }

    async function loadEligibleAccounts() {
        const tableKey = currentTableKey();
        if (!tableKey) throw new Error('TRADER_ACCOUNT_UI_TABLE_UNRESOLVED');

        const response = await STATE.originalFetch('/api/betting-houses', {
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            throw new Error(`TRADER_ACCOUNT_UI_HOUSES_HTTP_${response.status}`);
        }
        const payload = await response.json();
        const houses = Array.isArray(payload?.houses) ? payload.houses : [];

        STATE.eligibleAccounts = houses
            .filter(house => house?.enabled === true && house?.adapter_key === 'brasil-da-sorte')
            .map(house => {
                const table = (Array.isArray(house.tables) ? house.tables : [])
                    .find(item => item?.enabled === true && String(item.table_key || '').trim().toLowerCase() === tableKey);
                if (!table) return null;
                return Object.freeze({
                    id: Number(house.id),
                    name: String(house.name || `Conta ${house.id}`),
                    tableName: String(table.display_name || table.table_key || tableKey)
                });
            })
            .filter(item => item && Number.isSafeInteger(item.id) && item.id > 0)
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
        root.style.cssText = 'flex:2; min-width:280px; background:#111; border:1px solid #3f5264; border-radius:6px; padding:10px;';
        root.innerHTML = `
            <label style="color:#8ec5ff;">Conta(s) de Operação *</label>
            <div data-at-account-list style="display:flex; flex-direction:column; gap:7px; margin-top:5px;"></div>
            <small data-at-account-help style="color:#888; line-height:1.35; margin-top:5px;">
                Selecione ao menos uma conta. Apenas contas habilitadas para a mesa atual são exibidas.
            </small>
        `;
        formGroup.insertAdjacentElement('afterend', root);
        return root;
    }

    function renderAccounts() {
        const root = ensureContainer();
        if (!root) return false;
        const list = root.querySelector('[data-at-account-list]');
        if (!list) return false;

        if (STATE.eligibleAccounts.length === 0) {
            list.innerHTML = '<div style="color:#dc3545; font-size:12px;">Nenhuma conta habilitada possui esta mesa configurada.</div>';
            return true;
        }

        list.replaceChildren(...STATE.eligibleAccounts.map(account => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; align-items:center; gap:9px; padding:7px 9px; border:1px solid #333; border-radius:5px; background:#181818; cursor:pointer; text-transform:none; letter-spacing:0; font-size:12px; color:#ddd;';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.atAccountId = String(account.id);
            input.checked = STATE.selectedIds.has(account.id);
            input.addEventListener('change', () => {
                if (input.checked) STATE.selectedIds.add(account.id);
                else STATE.selectedIds.delete(account.id);
            });
            const text = document.createElement('span');
            text.textContent = `Conta ${account.id} — ${account.name} · ${account.tableName}`;
            label.append(input, text);
            return label;
        }));
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
                list.innerHTML = '<div style="color:#dc3545; font-size:12px;">Falha ao carregar contas disponíveis. Não salve o Trader até corrigir.</div>';
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
