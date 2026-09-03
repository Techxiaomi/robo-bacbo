'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAggregateExposure } = require('../signal_router_risk_gate');

function riskConfig(stopLoss, stopWin = 50) {
    return JSON.stringify({ stop_loss: stopLoss, stop_win: stopWin });
}

const HOMOLOGATION_CAPS = Object.freeze({
    global_router_cap: 20,
    per_bridge_cap: 5
});

test('approves aggregate exposure using only eligible bound accounts and explicit homologation caps', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [4, 1, 4],
        saldoInicial: 100,
        saldoAtual: 95,
        configJson: riskConfig(30),
        technicalCaps: HOMOLOGATION_CAPS
    });

    assert.equal(result.approved, true);
    assert.deepEqual(result.account_ids, [1, 4]);
    assert.equal(result.account_count, 2);
    assert.equal(result.per_account_exposure, 5);
    assert.equal(result.aggregate_exposure, 10);
    assert.equal(result.saldo_projetado, 85);
    assert.equal(result.stop_loss_floor, 70);
    assert.deepEqual(result.trader_limits, { stop_loss: 30, stop_win: 50 });
    assert.deepEqual(result.technical_caps, {
        global_exposure: 20,
        per_bridge_exposure: 5
    });
});

test('rejects whole batch when per-account exposure exceeds enabled bridge homologation cap', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5.01,
        eligibleAccountIds: [1],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: riskConfig(50),
        technicalCaps: HOMOLOGATION_CAPS
    });

    assert.equal(result.approved, false);
    assert.equal(result.reason, 'PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED');
    assert.equal(result.per_bridge_limit, 5);
});

test('rejects whole batch when aggregate balance is insufficient', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4, 7],
        saldoInicial: 20,
        saldoAtual: 14,
        configJson: riskConfig(20)
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'EXPOSURE_REJECTED');
    assert.equal(result.reason, 'INSUFFICIENT_AGGREGATE_BALANCE');
    assert.equal(result.aggregate_exposure, 15);
});

test('rejects whole batch when projected balance reaches stop loss floor', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4],
        saldoInicial: 100,
        saldoAtual: 80,
        configJson: riskConfig(30)
    });

    assert.equal(result.approved, false);
    assert.equal(result.reason, 'STOP_LOSS_PROJECTED');
    assert.equal(result.aggregate_exposure, 10);
    assert.equal(result.saldo_projetado, 70);
    assert.equal(result.stop_loss_floor, 70);
});

test('rejects whole batch when aggregate exposure exceeds enabled global homologation cap', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4, 7, 8, 9],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: riskConfig(50),
        technicalCaps: HOMOLOGATION_CAPS
    });

    assert.equal(result.approved, false);
    assert.equal(result.reason, 'GLOBAL_EXPOSURE_LIMIT_EXCEEDED');
    assert.equal(result.aggregate_exposure, 25);
    assert.equal(result.global_limit, 20);
    assert.deepEqual(result.technical_caps, {
        global_exposure: 20,
        per_bridge_exposure: 5
    });
});

test('fails closed when no eligible bound account exists', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: riskConfig(50)
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'EXPOSURE_REJECTED');
    assert.equal(result.reason, 'NO_ELIGIBLE_BOUND_ACCOUNTS');
});

test('missing stop_loss rejects with INVALID_RISK_POLICY instead of fallback', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: JSON.stringify({ stop_win: 50 })
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'INVALID_RISK_POLICY');
    assert.equal(result.reason, 'INVALID_RISK_POLICY');
    assert.equal(result.invalid_field, 'stop_loss');
});

test('invalid stop_loss rejects with INVALID_RISK_POLICY', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: JSON.stringify({ stop_loss: 0, stop_win: 50 })
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'INVALID_RISK_POLICY');
    assert.equal(result.reason, 'INVALID_RISK_POLICY');
    assert.equal(result.invalid_field, 'stop_loss');
});
