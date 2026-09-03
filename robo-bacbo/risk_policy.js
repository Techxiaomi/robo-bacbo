'use strict';

const { getTechnicalRiskCaps } = require('./technical_risk_caps');

const MAX_MONEY = 1000000;

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseTraderConfig(configJson) {
    if (plainObject(configJson)) return configJson;
    try {
        return plainObject(JSON.parse(String(configJson || ''))) || null;
    } catch (_) {
        return null;
    }
}

function positiveMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > MAX_MONEY) return null;
    const cents = Math.round(number * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) return null;
    return cents / 100;
}

function invalidRiskPolicy(field, value = null) {
    return Object.freeze({
        valid: false,
        code: 'INVALID_RISK_POLICY',
        field,
        value,
        trader_limits: null,
        technical_caps: null
    });
}

function resolveRiskPolicy({ configJson, technicalCaps = getTechnicalRiskCaps() } = {}) {
    const config = parseTraderConfig(configJson);
    if (!config) return invalidRiskPolicy('config');

    const stopLoss = positiveMoney(config.stop_loss);
    if (stopLoss == null) return invalidRiskPolicy('stop_loss', config.stop_loss ?? null);

    const stopWin = positiveMoney(config.stop_win);
    if (stopWin == null) return invalidRiskPolicy('stop_win', config.stop_win ?? null);

    const caps = plainObject(technicalCaps);
    if (!caps) return invalidRiskPolicy('technical_caps');

    const globalRouterCap = positiveMoney(caps.global_router_cap);
    if (globalRouterCap == null) {
        return invalidRiskPolicy('technical_global_router_cap', caps.global_router_cap ?? null);
    }

    const perBridgeCap = positiveMoney(caps.per_bridge_cap);
    if (perBridgeCap == null) {
        return invalidRiskPolicy('technical_per_bridge_cap', caps.per_bridge_cap ?? null);
    }

    return Object.freeze({
        valid: true,
        code: 'RISK_POLICY_VALID',
        trader_limits: Object.freeze({
            stop_loss: stopLoss,
            stop_win: stopWin
        }),
        technical_caps: Object.freeze({
            global_exposure: globalRouterCap,
            per_bridge_exposure: perBridgeCap
        })
    });
}

module.exports = {
    MAX_MONEY,
    parseTraderConfig,
    positiveMoney,
    resolveRiskPolicy
};
