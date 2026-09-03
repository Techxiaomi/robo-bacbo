'use strict';

(() => {
    const state = {
        installed: false,
        rules: null,
        originalOpen: null,
        originalEdit: null,
        originalSave: null,
        originalPreview: null
    };

    function money(value) {
        return `R$ ${Number(value).toFixed(2).replace('.', ',')}`;
    }

    function chipLabel(value) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return String(value ?? '');
        return Number.isInteger(amount)
            ? String(amount)
            : amount.toFixed(2).replace('.', ',');
    }

    function validStep(value, min, step) {
        const amount = Number(value);
        const minValue = Number(min);
        const stepValue = Number(step);
        if (!Number.isFinite(amount) || !Number.isFinite(minValue) || !Number.isFinite(stepValue)) return false;
        if (amount < minValue || stepValue <= 0) return false;
        const units = (amount - minValue) / stepValue;
        return Math.abs(units - Math.round(units)) < 1e-9;
    }

    function quantize(value, min, step) {
        const amount = Number(value);
        const minValue = Number(min);
        const stepValue = Number(step);
        if (!Number.isFinite(amount) || amount <= 0) return 0;
        if (!Number.isFinite(minValue) || !Number.isFinite(stepValue) || stepValue <= 0) return 0;
        if (amount <= minValue) return minValue;
        const units = Math.round((amount - minValue) / stepValue);
        return Math.round((minValue + units * stepValue) * 100) / 100;
    }

    async function loadRules() {
        const response = await fetch('/api/trader-account-catalog', {
            cache: 'no-store',
            credentials: 'same-origin'
        });
        const payload = await response.json();
        if (!response.ok || payload?.success !== true || !payload?.financial_rules) {
            throw new Error('TRADER_FINANCIAL_RULES_UNAVAILABLE');
        }
        state.rules = Object.freeze({ ...payload.financial_rules, chips: Object.freeze([...(payload.financial_rules.chips || [])]) });
        return state.rules;
    }

    function renderChips() {
        const rules = state.rules;
        if (!rules) return;
        const stake = document.getElementById('at-stake');
        const container = document.querySelector('.fichas-container');
        if (!stake || !container) return;

        stake.min = String(rules.min_stake);
        stake.step = String(rules.stake_step);
        stake.dataset.tableCode = rules.table_code;

        const label = container.parentElement?.querySelector('label');
        if (label) {
            label.textContent = `Adicionar Fichas · ${rules.table_code} · mínimo ${money(rules.min_stake)} · passo ${money(rules.stake_step)}`;
        }

        const buttons = (rules.chips || []).map(chip => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `ficha-btn f${String(chip).replace('.', '_')}`;
            button.textContent = chipLabel(chip);
            button.title = `${rules.table_code} · adicionar ${money(chip)}`;
            button.setAttribute('aria-label', `Adicionar ${money(chip)}`);
            button.addEventListener('click', () => {
                const current = Number(stake.value) || 0;
                stake.value = (current + Number(chip)).toFixed(2);
                window.atualizarPreviewProtecaoEmpateAutoTrader?.();
            });
            return button;
        });

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn';
        clear.textContent = '🧹 Limpar';
        clear.addEventListener('click', () => {
            stake.value = Number(rules.min_stake).toFixed(2);
            window.atualizarPreviewProtecaoEmpateAutoTrader?.();
        });

        container.replaceChildren(...buttons, clear);
    }

    function applyTieRules() {
        const rules = state.rules;
        if (!rules) return;
        const input = document.getElementById('at-tie-valor');
        if (!input) return;
        input.min = String(rules.tie_min);
        input.step = String(rules.tie_step);
        input.placeholder = `Ex: ${chipLabel(rules.tie_min)}`;
    }

    function validateFormMoney() {
        const rules = state.rules;
        if (!rules) return { ok: false, reason: 'Regras financeiras da mesa ainda não foram carregadas.' };
        const stake = Number(document.getElementById('at-stake')?.value);
        if (!validStep(stake, rules.min_stake, rules.stake_step)) {
            return {
                ok: false,
                reason: `Entrada inválida para ${rules.table_code}. Use valor mínimo ${money(rules.min_stake)} em passos exatos de ${money(rules.stake_step)}.`
            };
        }
        const mode = document.getElementById('at-tie-modo')?.value;
        if (mode === 'VALOR') {
            const tie = Number(document.getElementById('at-tie-valor')?.value);
            if (!validStep(tie, rules.tie_min, rules.tie_step)) {
                return {
                    ok: false,
                    reason: `Proteção Tie inválida para ${rules.table_code}. Use valor mínimo ${money(rules.tie_min)} em passos exatos de ${money(rules.tie_step)}.`
                };
            }
        }
        return { ok: true };
    }

    function installPreview() {
        if (typeof window.atualizarPreviewProtecaoEmpateAutoTrader !== 'function' || state.originalPreview) return;
        state.originalPreview = window.atualizarPreviewProtecaoEmpateAutoTrader;
        window.arredondarFichaAutoTrader = function tableAwareRound(value) {
            const rules = state.rules;
            if (!rules) return 0;
            return quantize(value, rules.min_stake, rules.stake_step);
        };
        window.atualizarPreviewProtecaoEmpateAutoTrader = function tableAwarePreview() {
            const rules = state.rules;
            if (!rules) return state.originalPreview();
            const mode = document.getElementById('at-tie-modo')?.value || 'PERCENTUAL';
            const stake = Number(document.getElementById('at-stake')?.value) || 0;
            const g1 = Number(document.getElementById('at-gale1')?.value) || 2;
            const g2 = Number(document.getElementById('at-gale2')?.value) || 4;
            const base = mode === 'PERCENTUAL'
                ? stake * ((Number(document.getElementById('at-tie-percent')?.value) || 0) / 100)
                : (Number(document.getElementById('at-tie-valor')?.value) || 0);
            const box = document.getElementById('at-tie-preview');
            if (!box) return;
            if (stake <= 0 || base <= 0) {
                box.innerText = 'Informe a política para visualizar os valores efetivos.';
                return;
            }
            const p0 = quantize(stake, rules.min_stake, rules.stake_step);
            const t0 = quantize(base, rules.tie_min, rules.tie_step);
            const p1 = quantize(stake * g1, rules.min_stake, rules.stake_step);
            const t1 = quantize(base * g1, rules.tie_min, rules.tie_step);
            const p2 = quantize(stake * g2, rules.min_stake, rules.stake_step);
            const t2 = quantize(base * g2, rules.tie_min, rules.tie_step);
            box.innerHTML = `${rules.table_code} · mínimo ${money(rules.min_stake)} · passo ${money(rules.stake_step)} — ` +
                `Direto: <strong>Cor ${money(p0)} + Tie ${money(t0)}</strong> | ` +
                `G1: <strong>Cor ${money(p1)} + Tie ${money(t1)}</strong> | ` +
                `G2: <strong>Cor ${money(p2)} + Tie ${money(t2)}</strong>`;
        };
    }

    function normalizeOnBlur() {
        const rules = state.rules;
        if (!rules) return;
        const pairs = [
            ['at-stake', rules.min_stake, rules.stake_step],
            ['at-tie-valor', rules.tie_min, rules.tie_step]
        ];
        for (const [id, min, step] of pairs) {
            const input = document.getElementById(id);
            if (!input || input.dataset.tableRulesBlur === '1') continue;
            input.dataset.tableRulesBlur = '1';
            input.addEventListener('blur', () => {
                const value = Number(input.value);
                if (!Number.isFinite(value) || value <= 0) return;
                input.value = quantize(value, min, step).toFixed(2);
                window.atualizarPreviewProtecaoEmpateAutoTrader?.();
            });
        }
    }

    async function apply() {
        await loadRules();
        renderChips();
        applyTieRules();
        installPreview();
        normalizeOnBlur();
        window.atualizarPreviewProtecaoEmpateAutoTrader?.();
    }

    function wrapFunctions() {
        if (typeof window.abrirFormularioAutoTrader === 'function' && !state.originalOpen) {
            state.originalOpen = window.abrirFormularioAutoTrader;
            window.abrirFormularioAutoTrader = async function(...args) {
                const result = await state.originalOpen.apply(this, args);
                await apply();
                return result;
            };
        }
        if (typeof window.prepararEdicaoAutoTrader === 'function' && !state.originalEdit) {
            state.originalEdit = window.prepararEdicaoAutoTrader;
            window.prepararEdicaoAutoTrader = async function(...args) {
                const result = await state.originalEdit.apply(this, args);
                await apply();
                return result;
            };
        }
        if (typeof window.salvarAutoTrader === 'function' && !state.originalSave) {
            state.originalSave = window.salvarAutoTrader;
            window.salvarAutoTrader = async function(...args) {
                const validation = validateFormMoney();
                if (!validation.ok) {
                    window.alert(validation.reason);
                    return false;
                }
                return state.originalSave.apply(this, args);
            };
        }
    }

    function install() {
        if (state.installed) return true;
        state.installed = true;
        wrapFunctions();
        return true;
    }

    window.__traderFinancialRulesUi = Object.freeze({ install, apply, validateFormMoney });
})();
