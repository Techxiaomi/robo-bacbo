'use strict';

const { normalizeAccountIds } = require('./trader_bound_tasks');
const { resolveRiskPolicy } = require('./risk_policy');

function cents(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    const result = Math.round(number * 100);
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function reject(reason, details = {}, code = 'EXPOSURE_REJECTED') {
    return Object.freeze({ approved: false, code, reason, ...details });
}

function approve(details) {
    return Object.freeze({ approved: true, code: 'EXPOSURE_APPROVED', reason: null, ...details });
}

function evaluateAggregateExposure({
    perAccountExposure,
    eligibleAccountIds,
    saldoInicial,
    saldoAtual,
    configJson,
    technicalCaps
}) {
    const riskPolicy = resolveRiskPolicy({ configJson, technicalCaps });
    if (!riskPolicy.valid) {
        return reject('INVALID_RISK_POLICY', {
            invalid_field: riskPolicy.field,
            trader_limits: null,
            technical_caps: null
        }, 'INVALID_RISK_POLICY');
    }

    const accountIds = normalizeAccountIds(eligibleAccountIds);
    if (accountIds.length === 0) return reject('NO_ELIGIBLE_BOUND_ACCOUNTS');

    const perAccountCents = cents(perAccountExposure);
    const initialCents = cents(saldoInicial);
    const currentCents = cents(saldoAtual);
    if (perAccountCents == null || perAccountCents <= 0) return reject('PER_ACCOUNT_EXPOSURE_INVALID');
    if (initialCents == null) return reject('SALDO_INICIAL_INVALID');
    if (currentCents == null) return reject('SALDO_ATUAL_INVALID');

    const perBridgeLimitCents = cents(riskPolicy.technical_caps.per_bridge_exposure);
    if (perAccountCents > perBridgeLimitCents) {
        return reject('PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED', {
            per_account_exposure: perAccountCents / 100,
            per_bridge_limit: perBridgeLimitCents / 100,
            trader_limits: riskPolicy.trader_limits,
            technical_caps: riskPolicy.technical_caps
        });
    }

    const aggregateCents = perAccountCents * accountIds.length;
    if (!Number.isSafeInteger(aggregateCents) || aggregateCents <= 0) return reject('AGGREGATE_EXPOSURE_INVALID');

    if (aggregateCents > currentCents) {
        return reject('INSUFFICIENT_AGGREGATE_BALANCE', {
            aggregate_exposure: aggregateCents / 100,
            saldo_atual: currentCents / 100,
            trader_limits: riskPolicy.trader_limits,
            technical_caps: riskPolicy.technical_caps
        });
    }

    const globalLimitCents = cents(riskPolicy.technical_caps.global_exposure);
    if (aggregateCents > globalLimitCents) {
        return reject('GLOBAL_EXPOSURE_LIMIT_EXCEEDED', {
            aggregate_exposure: aggregateCents / 100,
            global_limit: globalLimitCents / 100,
            trader_limits: riskPolicy.trader_limits,
            technical_caps: riskPolicy.technical_caps
        });
    }

    const stopLossCents = cents(riskPolicy.trader_limits.stop_loss);
    const projectedCents = currentCents - aggregateCents;
    const stopLossFloorCents = initialCents - stopLossCents;
    if (projectedCents <= stopLossFloorCents) {
        return reject('STOP_LOSS_PROJECTED', {
            aggregate_exposure: aggregateCents / 100,
            saldo_atual: currentCents / 100,
            saldo_projetado: projectedCents / 100,
            stop_loss: stopLossCents / 100,
            stop_loss_floor: stopLossFloorCents / 100,
            trader_limits: riskPolicy.trader_limits,
            technical_caps: riskPolicy.technical_caps
        });
    }

    return approve({
        account_ids: Object.freeze([...accountIds]),
        account_count: accountIds.length,
        per_account_exposure: perAccountCents / 100,
        aggregate_exposure: aggregateCents / 100,
        saldo_inicial: initialCents / 100,
        saldo_atual: currentCents / 100,
        saldo_projetado: projectedCents / 100,
        stop_loss: stopLossCents / 100,
        stop_loss_floor: stopLossFloorCents / 100,
        global_limit: globalLimitCents / 100,
        per_bridge_limit: perBridgeLimitCents / 100,
        trader_limits: riskPolicy.trader_limits,
        technical_caps: riskPolicy.technical_caps
    });
}

module.exports = { evaluateAggregateExposure };
