(() => {
    'use strict';

    const state = { houses: [], editingHouse: null, tableDrafts: [] };
    const $ = id => document.getElementById(id);

    function esc(value) {
        return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function setStatus(element, message, type = '') {
        element.textContent = message || '';
        element.className = `status-msg${type ? ` ${type}` : ''}`;
    }

    async function api(path, options = {}) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options
        });
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok || payload?.success === false) {
            const error = new Error(payload?.error || `HTTP_${response.status}`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    async function loadHouses() {
        setStatus($('status-global'), 'Carregando...');
        try {
            const includeDisabled = $('mostrar-inativas').checked ? '?include_disabled=1' : '';
            const payload = await api(`/api/betting-houses${includeDisabled}`);
            state.houses = Array.isArray(payload.houses) ? payload.houses : [];
            renderHouses();
            setStatus($('status-global'), `${state.houses.length} casa(s) carregada(s).`, 'ok');
        } catch (error) {
            state.houses = [];
            renderHouses();
            setStatus($('status-global'), `Falha ao carregar: ${error.message}`, 'erro');
        }
    }

    function renderHouses() {
        const root = $('lista-casas');
        if (state.houses.length === 0) {
            root.innerHTML = '<div class="vazio">Nenhuma casa cadastrada para o filtro atual.</div>';
            return;
        }
        root.innerHTML = state.houses.map(house => {
            const tables = Array.isArray(house.tables) ? house.tables : [];
            const activeTables = tables.filter(table => table.enabled === true).length;
            return `<article class="card ${house.enabled ? '' : 'inativo'}">
                <div class="card-topo">
                    <div><h2>${esc(house.name)}</h2><div class="meta">Adapter: ${esc(house.adapter_key)}</div><div class="meta">${esc(house.home_url)}</div></div>
                    <span class="badge ${house.enabled ? 'ativo' : 'inativo'}">${house.enabled ? '● Ativa' : '● Inativa'}</span>
                </div>
                <div class="meta" style="margin-top:8px;">Usuário: ${esc(house.username || 'não informado')} · Senha: ${house.has_password ? 'configurada' : 'não configurada'}</div>
                <div class="mesas-resumo"><div class="meta" style="margin-bottom:5px;">Mesas: ${activeTables} ativa(s) / ${tables.length} cadastrada(s)</div>${tables.map(table => `<div class="mesa-linha"><div><strong>${esc(table.display_name)}</strong><div class="meta">${esc(table.table_key)}</div></div><span class="badge ${table.enabled ? 'ativo' : 'inativo'}">${table.enabled ? 'Ativa' : 'Inativa'}</span></div>`).join('') || '<div class="meta">Nenhuma mesa cadastrada.</div>'}</div>
                <div class="card-acoes"><button class="btn pequeno secundario" type="button" data-edit-house="${Number(house.id)}">Editar</button>${house.enabled ? `<button class="btn pequeno perigo" type="button" data-disable-house="${Number(house.id)}">Desativar</button>` : ''}</div>
            </article>`;
        }).join('');
    }

    function blankTable() {
        return { id: null, table_key: '', display_name: '', game_url: '', enabled: true, isNew: true };
    }

    function renderTableEditors() {
        const root = $('mesas-editor');
        if (state.tableDrafts.length === 0) {
            root.innerHTML = '<div class="vazio" style="padding:18px;">Nenhuma mesa adicionada.</div>';
            return;
        }
        root.innerHTML = state.tableDrafts.map((table, index) => `<div class="mesa-editor" data-table-index="${index}">
            <div class="mesa-editor-grid">
                <div class="form-group"><label>Table key</label><input type="text" maxlength="80" data-field="table_key" value="${esc(table.table_key)}" placeholder="bacbo_br" required></div>
                <div class="form-group"><label>Nome exibido</label><input type="text" maxlength="120" data-field="display_name" value="${esc(table.display_name)}" placeholder="Bac Bo BR" required></div>
                <div class="form-group url"><label>URL da mesa</label><input type="url" maxlength="2048" data-field="game_url" value="${esc(table.game_url)}" required></div>
            </div>
            <div class="mesa-editor-acoes"><label style="display:flex;align-items:center;gap:8px;text-transform:none;"><input type="checkbox" data-field="enabled" ${table.enabled ? 'checked' : ''}> Mesa ativa</label><button type="button" class="btn pequeno ${table.id ? 'perigo' : 'secundario'}" data-remove-table="${index}">${table.id ? 'Desativar' : 'Remover'}</button></div>
        </div>`).join('');
    }

    function syncTableDraft(index, field, target) {
        const table = state.tableDrafts[index];
        if (!table) return;
        table[field] = field === 'enabled' ? target.checked : target.value;
    }

    function resetForm() {
        $('form-casa').reset();
        $('house-id').value = '';
        $('house-enabled').checked = true;
        $('house-password').value = '';
        state.editingHouse = null;
        state.tableDrafts = [blankTable()];
        updateEnabledLabel();
        renderTableEditors();
        setStatus($('status-modal'), '');
    }

    function openCreate() {
        resetForm();
        $('titulo-modal-casa').textContent = 'Nova casa';
        $('subtitulo-modal-casa').textContent = 'Cadastre a casa e suas mesas.';
        $('senha-ajuda').textContent = 'Preencha para definir a senha.';
        $('modal-casa').classList.add('aberto');
        $('house-name').focus();
    }

    async function openEdit(id) {
        setStatus($('status-global'), 'Carregando cadastro...');
        try {
            const payload = await api(`/api/betting-houses/${id}`);
            const house = payload.house;
            state.editingHouse = house;
            $('house-id').value = house.id;
            $('house-name').value = house.name || '';
            $('house-adapter-key').value = house.adapter_key || '';
            $('house-home-url').value = house.home_url || '';
            $('house-username').value = house.username || '';
            $('house-password').value = '';
            $('house-enabled').checked = house.enabled === true;
            state.tableDrafts = (Array.isArray(house.tables) ? house.tables : []).map(table => ({ ...table, isNew: false }));
            $('titulo-modal-casa').textContent = `Editar: ${house.name}`;
            $('subtitulo-modal-casa').textContent = 'Altere os dados gerais e gerencie as mesas vinculadas.';
            $('senha-ajuda').textContent = house.has_password ? 'Senha já configurada. Deixe vazio para manter a senha atual.' : 'Nenhuma senha configurada. Preencha para definir.';
            updateEnabledLabel();
            renderTableEditors();
            setStatus($('status-modal'), '');
            $('modal-casa').classList.add('aberto');
            setStatus($('status-global'), 'Cadastro carregado.', 'ok');
        } catch (error) {
            setStatus($('status-global'), `Falha ao abrir cadastro: ${error.message}`, 'erro');
        }
    }

    function closeModal() { $('modal-casa').classList.remove('aberto'); }
    function updateEnabledLabel() { $('house-enabled-label').textContent = $('house-enabled').checked ? 'Ativa' : 'Inativa'; }

    function housePayload() {
        const payload = {
            name: $('house-name').value.trim(),
            adapter_key: $('house-adapter-key').value.trim(),
            home_url: $('house-home-url').value.trim(),
            username: $('house-username').value.trim(),
            enabled: $('house-enabled').checked
        };
        const password = $('house-password').value;
        if (password !== '') payload.password = password;
        return payload;
    }

    function validateDraftTables() {
        for (const table of state.tableDrafts) {
            if (table.enabled === false && table.id) continue;
            if (!String(table.table_key || '').trim() || !String(table.display_name || '').trim() || !String(table.game_url || '').trim()) {
                throw new Error('Preencha table_key, nome e URL de todas as mesas ativas.');
            }
        }
    }

    async function saveHouse(event) {
        event.preventDefault();
        setStatus($('status-modal'), 'Salvando...');
        $('btn-salvar').disabled = true;
        try {
            validateDraftTables();
            const id = Number($('house-id').value || 0);
            let house;
            if (!id) {
                const payload = housePayload();
                payload.tables = state.tableDrafts.filter(t => t.enabled !== false).map(t => ({ table_key:t.table_key.trim(), display_name:t.display_name.trim(), game_url:t.game_url.trim(), enabled:t.enabled !== false }));
                house = (await api('/api/betting-houses', { method:'POST', body:JSON.stringify(payload) })).house;
            } else {
                house = (await api(`/api/betting-houses/${id}`, { method:'PUT', body:JSON.stringify(housePayload()) })).house;
                for (const table of state.tableDrafts) {
                    if (table.id) {
                        await api(`/api/betting-houses/${id}/tables/${table.id}`, { method:'PUT', body:JSON.stringify({ table_key:table.table_key.trim(), display_name:table.display_name.trim(), game_url:table.game_url.trim(), enabled:table.enabled === true }) });
                    } else if (table.enabled !== false) {
                        await api(`/api/betting-houses/${id}/tables`, { method:'POST', body:JSON.stringify({ table_key:table.table_key.trim(), display_name:table.display_name.trim(), game_url:table.game_url.trim(), enabled:true }) });
                    }
                }
            }
            setStatus($('status-modal'), `Cadastro ${house?.name || ''} salvo.`, 'ok');
            await loadHouses();
            closeModal();
        } catch (error) {
            setStatus($('status-modal'), `Falha ao salvar: ${error.message}`, 'erro');
        } finally {
            $('btn-salvar').disabled = false;
        }
    }

    async function disableHouse(id) {
        const house = state.houses.find(item => Number(item.id) === Number(id));
        if (!house || !confirm(`Desativar a casa "${house.name}"?`)) return;
        try {
            await api(`/api/betting-houses/${id}`, { method:'DELETE' });
            await loadHouses();
        } catch (error) {
            setStatus($('status-global'), `Falha ao desativar: ${error.message}`, 'erro');
        }
    }

    function bind() {
        $('btn-nova-casa').addEventListener('click', openCreate);
        $('btn-fechar-modal').addEventListener('click', closeModal);
        $('btn-cancelar').addEventListener('click', closeModal);
        $('form-casa').addEventListener('submit', saveHouse);
        $('mostrar-inativas').addEventListener('change', loadHouses);
        $('house-enabled').addEventListener('change', updateEnabledLabel);
        $('btn-adicionar-mesa').addEventListener('click', () => { state.tableDrafts.push(blankTable()); renderTableEditors(); });
        $('lista-casas').addEventListener('click', event => {
            const edit = event.target.closest('[data-edit-house]');
            if (edit) return void openEdit(edit.dataset.editHouse);
            const disable = event.target.closest('[data-disable-house]');
            if (disable) return void disableHouse(disable.dataset.disableHouse);
        });
        $('mesas-editor').addEventListener('input', event => {
            const editor = event.target.closest('[data-table-index]');
            const field = event.target.dataset.field;
            if (editor && field) syncTableDraft(Number(editor.dataset.tableIndex), field, event.target);
        });
        $('mesas-editor').addEventListener('change', event => {
            const editor = event.target.closest('[data-table-index]');
            const field = event.target.dataset.field;
            if (editor && field) syncTableDraft(Number(editor.dataset.tableIndex), field, event.target);
        });
        $('mesas-editor').addEventListener('click', event => {
            const button = event.target.closest('[data-remove-table]');
            if (!button) return;
            const index = Number(button.dataset.removeTable);
            const table = state.tableDrafts[index];
            if (!table) return;
            if (table.id) table.enabled = false; else state.tableDrafts.splice(index, 1);
            renderTableEditors();
        });
        $('modal-casa').addEventListener('click', event => { if (event.target === $('modal-casa')) closeModal(); });
    }

    document.addEventListener('DOMContentLoaded', () => { bind(); loadHouses(); });
})();
