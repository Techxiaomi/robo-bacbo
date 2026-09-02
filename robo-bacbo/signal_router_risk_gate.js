'use strict';

const { normalizeAccountIds } = require('./trader_bound_tasks');

function cents(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    const result = Math.round(number * 100);
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function parseConfig(configJson) {
    if (configJson && typeof configJson === 'object' && !Array.isArray(configJson)) return configJson;
    try {
        const parsed = JSON.parse(String(configJson || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function reject(reason, details = {}) {
    return Object.freeze({
        approved: false,
        code: 'EXPOSURE_REJECTED',
        reason,
        ...details
    });
}

function approve(details) {
    return Object.freeze({
        approved: true,
        code: 'EXPOSURE_APPROVED',
        reason: null,
        ...details
    });
}

function evaluateAggregateExposure({
    perAccountExposure,
    eligibleAccountIds,
    saldoInicial,
    saldoAtual,
    configJson,
    globalExposureLimit
}) {
    const accountIds = normalizeAccountIds(eligibleAccountIds);
    if (accountIds.length === 0) return reject('NO_ELIGIBLE_BOUND_ACCOUNTS');

    const perAccountCents = cents(perAccountExposure);
    const initialCents = cents(saldoInicial);
    const currentCents = cents(saldoAtual);
    if (perAccountCents == null || perAccountCents <= 0) return reject('PER_ACCOUNT_EXPOSURE_INVALID');
    if (initialCents == null) return reject('SALDO_INICIAL_INVALID');
    if (currentCents == null) return reject('SALDO_ATUAL_INVALID');

    const aggregateCents = perAccountCents * accountIds.length;
    if (!Number.isSafeInteger(aggregateCents) || aggregateCents <= 0) {
        return reject('AGGREGATE_EXPOSURE_INVALID');
    }

    if (aggregateCents > currentCents) {
        return reject('INSUFFICIENT_AGGREGATE_BALANCE', {
            aggregate_exposure: aggregateCents / 100,
            saldo_atual: currentCents / 100
        });
    }

    const globalLimitCents = cents(globalExposureLimit);
    if (globalLimitCents != null && globalLimitCents > 0 && aggregateCents > globalLimitCents) {
        return reject('GLOBAL_EXPOSURE_LIMIT_EXCEEDED', {
            aggregate_exposure: aggregateCents / 100,
            global_limit: globalLimitCents / 100
        });
    }

    const config = parseConfig(configJson);
    const stopLossNumber = Number(config.stop_loss);
    const stopLossCents = Number.isFinite(stopLossNumber) && stopLossNumber > 0
        ? Math.round(stopLossNumber * 100)
        : null;
    const projectedCents = currentCents - aggregateCents;
    const stopLossFloorCents = stopLossCents == null ? null : initialCents - stopLossCents;

    if (stopLossFloorCents != null && projectedCents <= stopLossFloorCents) {
        return reject('STOP_LOSS_PROJECTED', {
            aggregate_exposure: aggregateCents / 100,
            saldo_atual: currentCents / 100,
            saldo_projetado: projectedCents / 100,
            stop_loss: stopLossCents / 100,
            stop_loss_floor: stopLossFloorCents / 100
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
        stop_loss: stopLossCents == null ? null : stopLossCents / 100,
        stop_loss_floor: stopLossFloorCents == null ? null : stopLossFloorCents / 100,
        global_limit: globalLimitCents == null || globalLimitCents <= 0 ? null : globalLimitCents / 100
    });
}

module.exports = {
    evaluateAggregateExposure
};
