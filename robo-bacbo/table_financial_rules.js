'use strict';

const express = require('express');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const MONEY_LIMIT = 9_999_999_999.99;

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
    const units = amount / stepValue;
    return Math.abs(units - Math.round(units)) < 1e-9;
}

function quantizeMoney(value, rules, kind = 'stake') {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const min = kind === 'tie' ? Number(rules.tie_min) : Number(rules.min_stake);
    const step = kind === 'tie' ? Number(rules.tie_step) : Number(rules.stake_step);
    const rounded = Math.round(amount / step) * step;
    return Math.max(min, Math.round(rounded * 100) / 100);
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
    }

    return { ok: true, field: null, reason: null, rules };
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
    installTableFinancialRulesGuard
};
