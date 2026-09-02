'use strict';

(() => {
    const grid = document.querySelector('.risk-grid');
    if (!grid || document.getElementById('risk-config-editor')) return;

    const style = document.createElement('style');
    style.textContent = `
        .risk-editor{margin-top:12px;padding:12px;border:1px solid #2c2c2c;border-radius:8px;background:#111;display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}
        .risk-editor label{display:block;color:#888;font-size:10px;font-weight:800;text-transform:uppercase}
        .risk-editor input[type=number]{width:100%;margin-top:5px;background:#171717;color:#fff;border:1px solid #444;border-radius:6px;padding:8px}
        .risk-editor button{border:1px solid #315f7d;background:#17384d;color:#fff;border-radius:7px;padding:9px 12px;font-weight:800;cursor:pointer}
        .risk-editor-mode{grid-column:1/-1;color:#8f8f8f;font-size:11px}.risk-editor-mode input{vertical-align:middle}.risk-editor-msg{grid-column:1/-1;color:#aaa;font-size:11px}
        @media(max-width:700px){.risk-editor{grid-template-columns:1fr}.risk-editor-mode,.risk-editor-msg{grid-column:auto}}
    `;
    document.head.appendChild(style);

    const editor = document.createElement('div');
    editor.id = 'risk-config-editor';
    editor.className = 'risk-editor';
    editor.innerHTML = `
        <label>Cap global do Router (máx. R$ 20,00)<input id="cfg-global-cap" type="number" min="0.01" max="20" step="0.01"></label>
        <label>Cap por Live Bridge (máx. R$ 5,00)<input id="cfg-bridge-cap" type="number" min="0.01" max="5" step="0.01"></label>
        <button id="cfg-save" type="button">SALVAR CAPS</button>
        <div class="risk-editor-mode"><label><input type="checkbox" checked disabled> DRY RUN travado em ATIVO (fail-closed)</label></div>
        <div id="cfg-message" class="risk-editor-msg">Fonte: system_configs. Reduções passam a valer no próximo sinal do Router; processos recebem o snapshot DB no startup.</div>
    `;
    grid.insertAdjacentElement('afterend', editor);

    const globalInput = document.getElementById('cfg-global-cap');
    const bridgeInput = document.getElementById('cfg-bridge-cap');
    const saveButton = document.getElementById('cfg-save');
    const message = document.getElementById('cfg-message');

    async function load() {
        const response = await fetch('/api/financial-safety/risk-policy', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const snapshot = await response.json();
        globalInput.value = Number(snapshot?.technical_caps?.global_router_cap || 20).toFixed(2);
        bridgeInput.value = Number(snapshot?.technical_caps?.per_bridge_cap || 5).toFixed(2);
    }

    saveButton.addEventListener('click', async () => {
        saveButton.disabled = true;
        message.textContent = 'Salvando configuração segura no banco...';
        try {
            const response = await fetch('/api/financial-safety/system-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    global_router_cap: Number(globalInput.value),
                    per_bridge_cap: Number(bridgeInput.value),
                    financial_dry_run: true
                })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result?.reason || `HTTP_${response.status}`);
            message.textContent = '✅ Caps salvos no system_configs. DRY RUN permanece travado em ATIVO.';
            await load();
        } catch (error) {
            message.textContent = `⚠️ Configuração rejeitada: ${error.message}`;
        } finally {
            saveButton.disabled = false;
        }
    });

    load().catch(error => { message.textContent = `⚠️ Não foi possível carregar configuração: ${error.message}`; });
})();
