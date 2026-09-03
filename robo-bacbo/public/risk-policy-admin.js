'use strict';

(() => {
    const grid = document.querySelector('.risk-grid');
    if (!grid || document.getElementById('risk-config-editor')) return;

    const globalStatusCard = document.getElementById('risk-global-cap')?.closest('.risk-card');
    const bridgeStatusCard = document.getElementById('risk-bridge-cap')?.closest('.risk-card');
    if (globalStatusCard && bridgeStatusCard && globalStatusCard !== bridgeStatusCard) {
        grid.insertBefore(globalStatusCard, bridgeStatusCard);
    }

    const style = document.createElement('style');
    style.textContent = `
        .risk-editor{margin-top:12px;padding:12px;border:1px solid #2c2c2c;border-radius:8px;background:#111;display:grid;grid-template-columns:1fr 1fr auto auto;gap:10px;align-items:end}
        .risk-editor label{display:block;color:#888;font-size:10px;font-weight:800;text-transform:uppercase}
        .risk-editor input[type=number]{width:100%;margin-top:5px;background:#171717;color:#fff;border:1px solid #444;border-radius:6px;padding:8px}
        .risk-editor button{border:1px solid #315f7d;background:#17384d;color:#fff;border-radius:7px;padding:9px 12px;font-weight:800;cursor:pointer}
        .risk-editor button.secondary{border-color:#555;background:#252525}
        .risk-editor-mode{grid-column:1/-1;color:#8f8f8f;font-size:11px}.risk-editor-mode input{vertical-align:middle}.risk-editor-msg{grid-column:1/-1;color:#aaa;font-size:11px}
        .risk-runtime-state{grid-column:1/-1;margin-top:2px;padding:9px 10px;border:1px solid #2c2c2c;border-radius:6px;background:#161616;color:#bbb;font-size:11px;line-height:1.45}
        .risk-runtime-state.aligned{border-color:#245d35;color:#8be6a0}.risk-runtime-state.diverged{border-color:#665523;color:#ffd774}
        @media(max-width:700px){.risk-editor{grid-template-columns:1fr}.risk-editor-mode,.risk-editor-msg,.risk-runtime-state{grid-column:auto}}
    `;
    document.head.appendChild(style);

    const editor = document.createElement('div');
    editor.id = 'risk-config-editor';
    editor.className = 'risk-editor';
    editor.innerHTML = `
        <label>Cap global de homologação<input id="cfg-global-cap" type="number" min="0.01" max="99999" step="0.01"></label>
        <label>Cap por Bridge de homologação<input id="cfg-bridge-cap" type="number" min="0.01" max="99999" step="0.01"></label>
        <button id="cfg-save" type="button">SALVAR</button>
        <button id="cfg-reset" class="secondary" type="button">RESTAURAR PADRÃO</button>
        <div class="risk-editor-mode"><label><input id="cfg-caps-enabled" type="checkbox"> Habilitar caps técnicos</label> — desligado por padrão; ligue somente quando quiser homologar limites globais/por bridge.</div>
        <div class="risk-editor-mode"><label><input id="cfg-dry-run" type="checkbox"> Solicitação administrativa de DRY RUN</label> — este controle representa o valor solicitado; o runtime usa somente o valor efetivo informado pelo backend.</div>
        <div id="cfg-runtime-state" class="risk-runtime-state">Consultando requested/effective...</div>
        <div id="cfg-message" class="risk-editor-msg">Fonte: system_configs. Os valores dos caps permanecem editáveis mesmo quando o modo está desligado.</div>
    `;
    grid.insertAdjacentElement('afterend', editor);

    const globalInput = document.getElementById('cfg-global-cap');
    const bridgeInput = document.getElementById('cfg-bridge-cap');
    const capsEnabledInput = document.getElementById('cfg-caps-enabled');
    const dryRunInput = document.getElementById('cfg-dry-run');
    const saveButton = document.getElementById('cfg-save');
    const resetButton = document.getElementById('cfg-reset');
    const runtimeState = document.getElementById('cfg-runtime-state');
    const message = document.getElementById('cfg-message');

    function modeLabel(value) {
        return value === true ? 'DRY RUN' : 'PRODUÇÃO SOLICITADA';
    }

    function capsLabel(value) {
        return value === true ? 'CAPS ATIVOS' : 'CAPS DESABILITADOS';
    }

    function renderConfig(config) {
        const requested = config?.requested || {};
        const effective = config?.effective || {};
        globalInput.value = Number.isFinite(Number(requested.global_router_cap))
            ? Number(requested.global_router_cap).toFixed(2)
            : '';
        bridgeInput.value = Number.isFinite(Number(requested.per_bridge_cap))
            ? Number(requested.per_bridge_cap).toFixed(2)
            : '';
        capsEnabledInput.checked = requested.technical_risk_caps_enabled === true;
        dryRunInput.checked = requested.financial_dry_run !== false;

        const requestedGlobal = Number(requested.global_router_cap);
        const requestedBridge = Number(requested.per_bridge_cap);
        const effectiveGlobal = Number(effective.global_router_cap);
        const effectiveBridge = Number(effective.per_bridge_cap);
        const requestedCapsEnabled = requested.technical_risk_caps_enabled === true;
        const effectiveCapsEnabled = effective.technical_risk_caps_enabled === true;
        const requestedDryRun = requested.financial_dry_run !== false;
        const effectiveDryRun = effective.financial_dry_run !== false;
        const valuesAligned = Number.isFinite(requestedGlobal)
            && Number.isFinite(requestedBridge)
            && Number.isFinite(effectiveGlobal)
            && Number.isFinite(effectiveBridge)
            && requestedGlobal === effectiveGlobal
            && requestedBridge === effectiveBridge
            && requestedCapsEnabled === effectiveCapsEnabled
            && requestedDryRun === effectiveDryRun;

        runtimeState.className = `risk-runtime-state ${valuesAligned ? 'aligned' : 'diverged'}`;
        runtimeState.textContent = valuesAligned
            ? `✅ REQUESTED = EFFECTIVE — ${capsLabel(effectiveCapsEnabled)} | Global ${effectiveGlobal.toFixed(2)} | Bridge ${effectiveBridge.toFixed(2)} | ${modeLabel(effectiveDryRun)}`
            : `⚠️ REQUESTED ≠ EFFECTIVE — solicitado: ${capsLabel(requestedCapsEnabled)} | Global ${Number.isFinite(requestedGlobal) ? requestedGlobal.toFixed(2) : '—'} | Bridge ${Number.isFinite(requestedBridge) ? requestedBridge.toFixed(2) : '—'} | ${modeLabel(requestedDryRun)}; efetivo: ${capsLabel(effectiveCapsEnabled)} | Global ${Number.isFinite(effectiveGlobal) ? effectiveGlobal.toFixed(2) : '—'} | Bridge ${Number.isFinite(effectiveBridge) ? effectiveBridge.toFixed(2) : '—'} | ${modeLabel(effectiveDryRun)}`;

        if (config?.clamped === true) {
            const details = (config.discrepancies || [])
                .map(item => `${item.key}: solicitado=${item.requested_value}, efetivo=${item.effective_value}`)
                .join(' | ');
            message.textContent = `⚠️ Backend informou divergência requested/effective. ${details}`;
        } else if (effectiveCapsEnabled) {
            message.textContent = `✅ Caps técnicos ATIVOS: Global R$ ${effectiveGlobal.toFixed(2)} | Bridge R$ ${effectiveBridge.toFixed(2)}.`;
        } else {
            message.textContent = `✅ Caps técnicos DESABILITADOS. Valores preservados para futura homologação: Global R$ ${effectiveGlobal.toFixed(2)} | Bridge R$ ${effectiveBridge.toFixed(2)}.`;
        }
    }

    async function load() {
        const response = await fetch('/api/financial-safety/system-config', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.reason || `HTTP_${response.status}`);
        renderConfig(result.config);
    }

    saveButton.addEventListener('click', async () => {
        saveButton.disabled = true;
        message.textContent = 'Salvando configuração solicitada no banco...';
        try {
            const response = await fetch('/api/financial-safety/system-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    global_router_cap: Number(globalInput.value),
                    per_bridge_cap: Number(bridgeInput.value),
                    technical_risk_caps_enabled: capsEnabledInput.checked,
                    financial_dry_run: dryRunInput.checked
                })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result?.reason || `HTTP_${response.status}`);
            renderConfig(result.config);
        } catch (error) {
            message.textContent = `⚠️ Configuração rejeitada: ${error.message}`;
        } finally {
            saveButton.disabled = false;
        }
    });

    resetButton.addEventListener('click', async () => {
        resetButton.disabled = true;
        message.textContent = 'Restaurando defaults do system_configs...';
        try {
            const response = await fetch('/api/financial-safety/system-config', { method: 'DELETE' });
            const result = await response.json();
            if (!response.ok) throw new Error(result?.reason || `HTTP_${response.status}`);
            renderConfig(result.config);
        } catch (error) {
            message.textContent = `⚠️ Falha ao restaurar configuração: ${error.message}`;
        } finally {
            resetButton.disabled = false;
        }
    });

    load().catch(error => {
        runtimeState.className = 'risk-runtime-state diverged';
        runtimeState.textContent = '⚠️ Estado requested/effective indisponível.';
        message.textContent = `⚠️ Não foi possível carregar configuração: ${error.message}`;
    });
})();
