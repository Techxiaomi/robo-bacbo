'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    mapTraderRiskPolicy,
    readRiskPolicyObservability
} = require('../risk_policy_observability');

function observabilityPool({ configRows = [], traderRows = [] } = {}) {
    return {
        async query(sql) {
            if (/CREATE TABLE IF NOT EXISTS system_configs/.test(sql)) return [{ affectedRows: 0 }];
            if (/INSERT IGNORE INTO system_configs/.test(sql)) return [{ affectedRows: 0 }];
            if (/SELECT config_key, config_value/.test(sql)) return [configRows];
            if (/FROM auto_traders/.test(sql)) return [traderRows];
            throw new Error(`unexpected query: ${sql}`);
        }
    };
}

const DEFAULT_CAPS = Object.freeze({
    global_router_cap: 20,
    per_bridge_cap: 5
});

function validConfigRows(overrides = {}) {
    return [
        { config_key: 'global_router_cap', config_value: String(overrides.global_router_cap ?? 20) },
        { config_key: 'per_bridge_cap', config_value: String(overrides.per_bridge_cap ?? 5) },
        { config_key: 'financial_dry_run', config_value: String(overrides.financial_dry_run ?? true) }
    ];
}

test('maps active Trader business limits without technical fallback', () => {
    const mapped = mapTraderRiskPolicy({
        id: 18,
        nome: 'Trader 18',
        status_operacao: 'OPERANDO',
        config_json: JSON.stringify({ stop_loss: 30, stop_win: 20 })
    }, DEFAULT_CAPS);

    assert.equal(mapped.valid, true);
    assert.equal(mapped.stop_loss, 30);
    assert.equal(mapped.stop_win, 20);
    assert.equal(mapped.source, 'auto_traders.config_json');
});

test('invalid Trader policy is exposed as INVALID_RISK_POLICY', () => {
    const mapped = mapTraderRiskPolicy({
        id: 18,
        nome: 'Trader 18',
        status_operacao: 'OPERANDO',
        config_json: JSON.stringify({ stop_win: 20 })
    }, DEFAULT_CAPS);

    assert.equal(mapped.valid, false);
    assert.equal(mapped.code, 'INVALID_RISK_POLICY');
    assert.equal(mapped.invalid_field, 'stop_loss');
    assert.equal(mapped.stop_loss, null);
});

test('observability separates Trader limits, DB technical caps and forced DRY RUN mode', async () => {
    const dbPool = observabilityPool({
        configRows: validConfigRows({ global_router_cap: 12.5, per_bridge_cap: 3.25 }),
        traderRows: [{
            id: 18,
            nome: 'Trader 18',
            status_operacao: 'OPERANDO',
            config_json: JSON.stringify({ stop_loss: 30, stop_win: 20 })
        }]
    });

    const snapshot = await readRiskPolicyObservability({ dbPool });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.fail_closed, false);
    assert.deepEqual(snapshot.technical_caps, {
        global_router_cap: 12.5,
        per_bridge_cap: 3.25,
        source: 'system_configs'
    });
    assert.equal(snapshot.financial_mode.dry_run, true);
    assert.equal(snapshot.financial_mode.real_dispatch_blocked, true);
    assert.equal(snapshot.financial_mode.immutable, true);
    assert.equal(snapshot.financial_mode.source, 'system_configs.financial_dry_run');
    assert.equal(snapshot.business_policy.available, true);
    assert.equal(snapshot.business_policy.active_traders[0].stop_loss, 30);
    assert.equal(snapshot.business_policy.active_traders[0].stop_win, 20);
});

test('stored financial_dry_run=false remains blocked and marks observability fail-closed', async () => {
    const dbPool = observabilityPool({
        configRows: validConfigRows({ financial_dry_run: false }),
        traderRows: []
    });

    const snapshot = await readRiskPolicyObservability({ dbPool });
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.fail_closed, true);
    assert.equal(snapshot.financial_mode.dry_run, true);
    assert.equal(snapshot.financial_mode.real_dispatch_blocked, true);
    assert.equal(snapshot.financial_mode.immutable, true);
    assert.match(String(snapshot.financial_mode.reason), /FINANCIAL_DRY_RUN_FORCED_TRUE/);
});

test('DB failure falls back to safe defaults and remains fail-closed', async () => {
    const dbPool = {
        async query() {
            const error = new Error('db unavailable');
            error.code = 'ECONNREFUSED';
            throw error;
        }
    };

    const snapshot = await readRiskPolicyObservability({ dbPool });
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.fail_closed, true);
    assert.equal(snapshot.technical_caps.global_router_cap, 20);
    assert.equal(snapshot.technical_caps.per_bridge_cap, 5);
    assert.equal(snapshot.technical_caps.source, 'safe-defaults');
    assert.equal(snapshot.financial_mode.dry_run, true);
    assert.equal(snapshot.financial_mode.real_dispatch_blocked, true);
    assert.equal(snapshot.business_policy.available, false);
});
