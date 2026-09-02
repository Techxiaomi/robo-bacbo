'use strict';

const express = require('express');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const MONEY_LIMIT = 9_999_999_999.99;
const LEGACY_VALIDATOR_BRIDGE_MARK = Symbol.for('robo-bacbo.table-financial-rules.validator-bridge');

const TABLE_FINANCIAL_RULES = Object.freeze({
    BACBO_BR: Object.freeze({
        table_key: 'bacbo_br',
        table_code: 'BACBO_BR',
        currency: 'BRL',
        min_stake: 5,
        stake_step: 5,
        tie_min: 5,
        tie_step: 5,
        chips: Object.freeze([5, 10, 25, 125, 500]),
        rounding: 'NEAREST_STEP'
    }),
    BACBO_INT: Object.freeze({
        table_key: 'bacbo_int',
        table_code: 'BACBO_INT',
        currency: 'BRL',
        min_stake: 5,
        stake_step: 5,
        tie_min: 5,
        tie_step: 5,
        chips: Object.freeze([5, 10, 25, 125, 500]),
        rounding: 'NEAREST_STEP'
    })
});

function normalizeTableCode(value) {
    return String(value || '').trim().toUpperCase();
}

function getTableFinancialRules(tableCode) {
    const code = normalizeTableCode(tableCode);
    const rules = TABLE_FINANCIAL_RULES[code];
    if (!rules) {
        throw new Error(`TABLE_FINANCIAL_RULES_UNSUPPORTED_TABLE:${code || '<empty>'}`);
    }
    return rules;
}

function publicTableFinancialRules(tableCode) {
    const rules = getTableFinancialRules(tableCode);
    return Object.freeze({
        table_key: rules.table_key,
        table_code: rules.table_code,
        currency: rules.currency,
        min_stake: rules.min_stake,
        stake_step: rules.stake_step,
        tie_min: rules.tie_min,
        tie_step: rules.tie_step,
        chips: Object.freeze([...rules.chips]),
        rounding: rules.rounding
    });
}

function isExactStep(value, min, step) {
    const amount = Number(value);
    const minValue = Number(min);
    const stepValue = Number(step);
    if (!Number.isFinite(amount) || !Number.isFinite(minValue) || !Number.isFinite(stepValue)) return false;
    if (amount < minValue || amount > MONEY_LIMIT || stepValue <= 0) return false;
    const units = (amount - minValue) / stepValue;
    return Math.abs(units - Math.round(units)) < 1e-9;
}

function quantizeMoney(value, rules, kind = 'stake') {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const min = kind === 'tie' ? Number(rules.tie_min) : Number(rules.min_stake);
    const step = kind === 'tie' ? Number(rules.tie_step) : Number(rules.stake_step);
    if (amount <= min) return min;
    const units = Math.round((amount - min) / step);
    return Math.round((min + units * step) * 100) / 100;
}

function validateAutoTraderMoneyRules(config, tableCode) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, field: 'config', reason: 'config deve ser um objeto JSON' };
    }

    let rules;
    try {
        rules = getTableFinancialRules(tableCode);
    } catch (error) {
        return { ok: false, field: 'table', reason: error.message };
    }

    const stake = Number(config.stake_inicial);
    if (!isExactStep(stake, rules.min_stake, rules.stake_step)) {
        return {
            ok: false,
            field: 'stake_inicial',
            reason: `stake_inicial: deve ser no mínimo R$ ${rules.min_stake.toFixed(2)} e respeitar passos exatos de R$ ${rules.stake_step.toFixed(2)} na mesa ${rules.table_code}`,
            rules
        };
    }

    const gale2 = Number(config.gale_2_mult);
    if (Number.isFinite(gale2) && gale2 > 0 && stake * gale2 > MONEY_LIMIT) {
        return {
            ok: false,
            field: 'gale_2_mult',
            reason: `gale_2_mult: com a stake configurada ultrapassa o limite financeiro na mesa ${rules.table_code}`,
            rules
        };
    }

    const tieMode = String(config.tie_stake_mode || '').trim().toUpperCase();
    if (tieMode === 'VALOR') {
        const tieValue = Number(config.tie_stake_value);
        if (!isExactStep(tieValue, rules.tie_min, rules.tie_step)) {
            return {
                ok: false,
                field: 'tie_stake_value',
                reason: `tie_stake_value: deve ser no mínimo R$ ${rules.tie_min.toFixed(2)} e respeitar passos exatos de R$ ${rules.tie_step.toFixed(2)} na mesa ${rules.table_code}`,
                rules
            };
        }
        if (Number.isFinite(gale2) && gale2 > 0 && tieValue * gale2 > MONEY_LIMIT) {
            return {
                ok: false,
                field: 'tie_stake_value',
                reason: `tie_stake_value: com gale_2_mult ultrapassa o limite financeiro na mesa ${rules.table_code}`,
                rules
            };
        }
    }

    return { ok: true, field: null, reason: null, rules };
}

function installTableAwareConfigValidationBridge() {
    const legacyModule = require('./bug051d_config_validation');
    if (legacyModule[LEGACY_VALIDATOR_BRIDGE_MARK]) return true;
    const original = legacyModule.validarConfiguracaoAutoTrader;
    if (typeof original !== 'function') {
        throw new Error('TABLE_FINANCIAL_RULES_LEGACY_VALIDATOR_UNAVAILABLE');
    }

    legacyModule.validarConfiguracaoAutoTrader = function validarConfiguracaoAutoTraderTableAware(config) {
        const mesa = obterMesaRuntime();
        const moneyValidation = validateAutoTraderMoneyRules(config, mesa.codigo);
        if (!moneyValidation.ok) {
            return {
                ok: false,
                campo: moneyValidation.field,
                motivo: moneyValidation.reason
            };
        }

        const rules = moneyValidation.rules;
        const safeLegacyConfig = {
            ...config,
            stake_inicial: rules.min_stake
        };
        if (String(config?.tie_stake_mode || '').trim().toUpperCase() === 'VALOR') {
            safeLegacyConfig.tie_stake_value = rules.tie_min;
        }

        return original(safeLegacyConfig);
    };

    Object.defineProperty(legacyModule, LEGACY_VALIDATOR_BRIDGE_MARK, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
    console.log('TABLE_FINANCIAL_RULES_VALIDATOR_BRIDGE_READY=true');
    return true;
}

let installed = false;
let postOriginal = null;
let putOriginal = null;

function installTableFinancialRulesGuard() {
    if (installed) return true;
    const proto = express.application;
    if (!proto || typeof proto.post !== 'function' || typeof proto.put !== 'function') {
        throw new Error('TABLE_FINANCIAL_RULES_EXPRESS_UNAVAILABLE');
    }

    postOriginal = proto.post;
    putOriginal = proto.put;

    function wrapHandlers(path, handlers) {
        const isTraderCreate = path === '/api/auto-trader';
        const isTraderUpdate = path === '/api/auto-trader/:id';
        if (!isTraderCreate && !isTraderUpdate) return handlers;

        return handlers.map(handler => {
            if (typeof handler !== 'function') return handler;
            return function tableAwareFinancialRulesMiddleware(req, res, next) {
                const config = req?.body?.config;
                const mesa = obterMesaRuntime();
                const validation = validateAutoTraderMoneyRules(config, mesa.codigo);
                if (!validation.ok) {
                    console.warn(
                        `TABLE_FINANCIAL_RULES_REJECTED table=${mesa.codigo} field=${validation.field} reason=${validation.reason}`
                    );
                    return res.status(400).json({
                        sucesso: false,
                        erro: validation.reason,
                        campo: validation.field,
                        table_code: mesa.codigo,
                        financial_rules: publicTableFinancialRules(mesa.codigo)
                    });
                }
                return handler(req, res, next);
            };
        });
    }

    proto.post = function postWithTableFinancialRules(path, ...handlers) {
        return postOriginal.call(this, path, ...wrapHandlers(path, handlers));
    };
    proto.put = function putWithTableFinancialRules(path, ...handlers) {
        return putOriginal.call(this, path, ...wrapHandlers(path, handlers));
    };

    installed = true;
    console.log('TABLE_FINANCIAL_RULES_GUARD_READY=true');
    return true;
}

module.exports = {
    MONEY_LIMIT,
    TABLE_FINANCIAL_RULES,
    normalizeTableCode,
    getTableFinancialRules,
    publicTableFinancialRules,
    isExactStep,
    quantizeMoney,
    validateAutoTraderMoneyRules,
    installTableAwareConfigValidationBridge,
    installTableFinancialRulesGuard
};
