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
        .risk-editor-mode{grid-column:1/-1;color:#8f8f8f;font-size:11px}.risk-editor-mode input{vertical-align:middle}
        .risk-editor-msg{grid-column:1/-1;color:#aaa;font-size:11px}
        .risk-runtime-state{grid-column:1/-1;margin-top:2px;padding:9px 10px;border:1px solid #2c2c2c;border-radius:6px;background:#161616;color:#bbb;font-size:11px;line-height:1.45}
        .risk-runtime-state.aligned{border-color:#245d35;color:#8be6a0}.risk-runtime-state.diverged{border-color:#665523;color:#ffd774}
        .financial-mode-panel{grid-column:1/-1;padding:12px;border:1px solid #333;border-radius:8px;background:#151515}
        .financial-mode-toggle{display:flex;gap:10px;align-items:center;font-size:12px;font-weight:900;color:#ddd}
        .financial-mode-badge{display:inline-block;margin-top:9px;padding:7px 10px;border-radius:999px;font-size:11px;font-weight:900;letter-spacing:.04em}
        .financial-mode-badge.dry{border:1px solid #315f7d;color:#9ed7ff;background:#122330}
        .financial-mode-badge.armed{border:1px solid #8b5a20;color:#ffd38a;background:#2d2113}
        .financial-mode-note{margin-top:8px;color:#aaa;font-size:11px;line-height:1.45}
        @media(max-width:700px){.risk-editor{grid-template-columns:1fr}.risk-editor-mode,.risk-editor-msg,.risk-runtime-state,.financial-mode-panel{grid-column:auto}}
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
        <div class="financial-mode-panel">
            <label class="financial-mode-toggle"><input id="cfg-armed-review" type="checkbox"> Alternar para ARMED_REVIEW</label>
            <div id="cfg-financial-mode-badge" class="financial-mode-badge dry">DRY RUN</div>
            <div class="financial-mode-note">DRY_RUN: nenhuma ordem financeira é enviada. ARMED_REVIEW: a ordem é preparada e enfileirada para revisão humana; despacho automático continua bloqueado.</div>
        </div>
        <div id="cfg-runtime-state" class="risk-runtime-state">Consultando estado administrativo...</div>
        <div id="cfg-message" class="risk-editor-msg">Fonte: system_configs. Alterações de modo são registradas no log de auditoria do backend.</div>
    `;
    grid.insertAdjacentElement('afterend', editor);

    const globalInput = document.getElementById('cfg-global-cap');
    const bridgeInput = document.getElementById('cfg-bridge-cap');
    const capsEnabledInput = document.getElementById('cfg-caps-enabled');
    const armedReviewInput = document.getElementById('cfg-armed-review');
    const modeBadge = document.getElementById('cfg-financial-mode-badge');
    const saveButton = document.getElementById('cfg-save');
    const resetButton = document.getElementById('cfg-reset');
    const runtimeState = document.getElementById('cfg-runtime-state');
    const message = document.getElementById('cfg-message');

    function capsLabel(value) {
        return value === true ? 'CAPS ATIVOS' : 'CAPS DESABILITADOS';
    }

    function renderMode(mode) {
        const armed = mode === 'ARMED_REVIEW';
        armedReviewInput.checked = armed;
        modeBadge.className = `financial-mode-badge ${armed ? 'armed' : 'dry'}`;
        modeBadge.textContent = armed
            ? 'ARMADO — CONFIRMAÇÃO HUMANA OBRIGATÓRIA'
            : 'DRY RUN';
    }

    function renderConfig(config) {
        const requested = config?.requested || {};
        const effective = config?.effective || {};
        const mode = String(config?.financial_mode || effective.financial_mode || requested.financial_mode || 'DRY_RUN').toUpperCase();

        globalInput.value = Number.isFinite(Number(requested.global_router_cap))
            ? Number(requested.global_router_cap).toFixed(2)
            : '';
        bridgeInput.value = Number.isFinite(Number(requested.per_bridge_cap))
            ? Number(requested.per_bridge_cap).toFixed(2)
            : '';
        capsEnabledInput.checked = requested.technical_risk_caps_enabled === true;
        renderMode(mode);

        const requestedGlobal = Number(requested.global_router_cap);
        const requestedBridge = Number(requested.per_bridge_cap);
        const effectiveGlobal = Number(effective.global_router_cap);
        const effectiveBridge = Number(effective.per_bridge_cap);
        const requestedCapsEnabled = requested.technical_risk_caps_enabled === true;
        const effectiveCapsEnabled = effective.technical_risk_caps_enabled === true;
        const capsAligned = Number.isFinite(requestedGlobal)
            && Number.isFinite(requestedBridge)
            && Number.isFinite(effectiveGlobal)
            && Number.isFinite(effectiveBridge)
            && requestedGlobal === effectiveGlobal
            && requestedBridge === effectiveBridge
            && requestedCapsEnabled === effectiveCapsEnabled;
        const safeMode = ['DRY_RUN', 'ARMED_REVIEW'].includes(mode)
            && config?.automatic_financial_dispatch === false;

        runtimeState.className = `risk-runtime-state ${(capsAligned && safeMode && config?.fail_closed !== true) ? 'aligned' : 'diverged'}`;
        runtimeState.textContent =
            `${mode === 'ARMED_REVIEW' ? '⚠️ ARMADO — CONFIRMAÇÃO HUMANA OBRIGATÓRIA' : '✅ DRY RUN'} | ` +
            `${capsLabel(effectiveCapsEnabled)} | Global ${Number.isFinite(effectiveGlobal) ? effectiveGlobal.toFixed(2) : '—'} | ` +
            `Bridge ${Number.isFinite(effectiveBridge) ? effectiveBridge.toFixed(2) : '—'} | ` +
            `despacho automático=${config?.automatic_financial_dispatch === false ? 'BLOQUEADO' : 'INDETERMINADO'}`;

        if (config?.clamped === true) {
            const details = (config.discrepancies || [])
                .map(item => `${item.key}: solicitado=${item.requested_value}, efetivo=${item.effective_value}`)
                .join(' | ');
            message.textContent = `⚠️ Backend informou configuração inválida/clamped. ${details}`;
        } else if (mode === 'ARMED_REVIEW') {
            message.textContent = '⚠️ ARMED_REVIEW ativo: ordens financeiras podem ser preparadas/enfileiradas, mas exigem confirmação humana e não são despachadas automaticamente.';
        } else {
            message.textContent = '✅ DRY_RUN ativo: nenhuma ordem financeira é despachada.';
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
        message.textContent = 'Salvando configuração administrativa no banco...';
        try {
            const response = await fetch('/api/financial-safety/system-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    global_router_cap: Number(globalInput.value),
                    per_bridge_cap: Number(bridgeInput.value),
                    technical_risk_caps_enabled: capsEnabledInput.checked,
                    financial_dry_run: !armedReviewInput.checked
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
        message.textContent = 'Restaurando DRY_RUN e defaults do system_configs...';
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
        runtimeState.textContent = '⚠️ Estado administrativo indisponível.';
        message.textContent = `⚠️ Não foi possível carregar configuração: ${error.message}`;
    });
})();
