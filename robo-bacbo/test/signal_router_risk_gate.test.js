'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAggregateExposure } = require('../signal_router_risk_gate');

test('approves aggregate exposure using only eligible bound accounts', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [4, 1, 4],
        saldoInicial: 100,
        saldoAtual: 95,
        configJson: JSON.stringify({ stop_loss: 30 }),
        globalExposureLimit: 20
    });

    assert.equal(result.approved, true);
    assert.deepEqual(result.account_ids, [1, 4]);
    assert.equal(result.account_count, 2);
    assert.equal(result.per_account_exposure, 5);
    assert.equal(result.aggregate_exposure, 10);
    assert.equal(result.saldo_projetado, 85);
    assert.equal(result.stop_loss_floor, 70);
});

test('rejects whole batch when aggregate balance is insufficient', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 8,
        eligibleAccountIds: [1, 4],
        saldoInicial: 20,
        saldoAtual: 15,
        configJson: JSON.stringify({ stop_loss: 20 }),
        globalExposureLimit: 50
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'EXPOSURE_REJECTED');
    assert.equal(result.reason, 'INSUFFICIENT_AGGREGATE_BALANCE');
    assert.equal(result.aggregate_exposure, 16);
});

test('rejects whole batch when projected balance reaches stop loss floor', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [1, 4],
        saldoInicial: 100,
        saldoAtual: 80,
        configJson: JSON.stringify({ stop_loss: 30 }),
        globalExposureLimit: 50
    });

    assert.equal(result.approved, false);
    assert.equal(result.reason, 'STOP_LOSS_PROJECTED');
    assert.equal(result.aggregate_exposure, 10);
    assert.equal(result.saldo_projetado, 70);
    assert.equal(result.stop_loss_floor, 70);
});

test('rejects whole batch when aggregate exposure exceeds global limit', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 7,
        eligibleAccountIds: [1, 4, 7],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: JSON.stringify({ stop_loss: 50 }),
        globalExposureLimit: 20
    });

    assert.equal(result.approved, false);
    assert.equal(result.reason, 'GLOBAL_EXPOSURE_LIMIT_EXCEEDED');
    assert.equal(result.aggregate_exposure, 21);
    assert.equal(result.global_limit, 20);
});

test('fails closed when no eligible bound account exists', () => {
    const result = evaluateAggregateExposure({
        perAccountExposure: 5,
        eligibleAccountIds: [],
        saldoInicial: 100,
        saldoAtual: 100,
        configJson: JSON.stringify({ stop_loss: 50 }),
        globalExposureLimit: 20
    });

    assert.equal(result.approved, false);
    assert.equal(result.code, 'EXPOSURE_REJECTED');
    assert.equal(result.reason, 'NO_ELIGIBLE_BOUND_ACCOUNTS');
});
