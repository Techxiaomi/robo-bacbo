'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    readDryRunLauncherState,
    mapTraderRiskPolicy,
    readRiskPolicyObservability
} = require('../risk_policy_observability');

function tempProjectWithLauncher(value) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bacbo-risk-observability-'));
    const shortcuts = path.join(root, 'atalhos');
    fs.mkdirSync(shortcuts, { recursive: true });
    fs.writeFileSync(
        path.join(shortcuts, '07_SIGNAL_ROUTER.cmd'),
        `@echo off\r\nset "SIGNAL_ROUTER_FINANCIAL_DRY_RUN=${value}"\r\n`,
        'utf8'
    );
    return root;
}

test('reads DRY_RUN=true only from canonical Signal Router launcher', () => {
    const projectRoot = tempProjectWithLauncher('true');
    try {
        const state = readDryRunLauncherState(projectRoot);
        assert.equal(state.configured, true);
        assert.equal(state.dry_run, true);
        assert.equal(state.source, path.join('atalhos', '07_SIGNAL_ROUTER.cmd'));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('missing DRY_RUN setting is fail-closed observability state', () => {
    const projectRoot = tempProjectWithLauncher('true');
    try {
        fs.writeFileSync(
            path.join(projectRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'),
            '@echo off\r\n',
            'utf8'
        );
        const state = readDryRunLauncherState(projectRoot);
        assert.equal(state.configured, false);
        assert.equal(state.dry_run, null);
        assert.equal(state.reason, 'DRY_RUN_SETTING_NOT_FOUND');
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('maps active Trader business limits without technical fallback', () => {
    const mapped = mapTraderRiskPolicy({
        id: 18,
        nome: 'Trader 18',
        status_operacao: 'OPERANDO',
        config_json: JSON.stringify({ stop_loss: 30, stop_win: 20 })
    });

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
    });

    assert.equal(mapped.valid, false);
    assert.equal(mapped.code, 'INVALID_RISK_POLICY');
    assert.equal(mapped.invalid_field, 'stop_loss');
    assert.equal(mapped.stop_loss, null);
});

test('observability separates Trader limits, technical caps and DRY RUN mode', async () => {
    const projectRoot = tempProjectWithLauncher('true');
    const dbPool = {
        async query(sql) {
            assert.match(sql, /FROM auto_traders/);
            assert.match(sql, /WHERE ativo=true/);
            return [[{
                id: 18,
                nome: 'Trader 18',
                status_operacao: 'OPERANDO',
                config_json: JSON.stringify({ stop_loss: 30, stop_win: 20 })
            }]];
        }
    };

    try {
        const snapshot = await readRiskPolicyObservability({ dbPool, projectRoot });
        assert.equal(snapshot.ok, true);
        assert.equal(snapshot.fail_closed, false);
        assert.deepEqual(snapshot.technical_caps, {
            global_router_cap: 20,
            per_bridge_cap: 5,
            source: 'robo-bacbo/technical_risk_caps.js'
        });
        assert.equal(snapshot.financial_mode.dry_run, true);
        assert.equal(snapshot.financial_mode.real_dispatch_blocked, true);
        assert.equal(snapshot.business_policy.active_traders[0].stop_loss, 30);
        assert.equal(snapshot.business_policy.active_traders[0].stop_win, 20);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('observability becomes fail-closed when launcher says DRY_RUN=false', async () => {
    const projectRoot = tempProjectWithLauncher('false');
    const dbPool = { async query() { return [[]]; } };

    try {
        const snapshot = await readRiskPolicyObservability({ dbPool, projectRoot });
        assert.equal(snapshot.ok, false);
        assert.equal(snapshot.fail_closed, true);
        assert.equal(snapshot.financial_mode.dry_run, false);
        assert.equal(snapshot.financial_mode.real_dispatch_blocked, false);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});
