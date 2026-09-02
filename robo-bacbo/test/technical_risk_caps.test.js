'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getTechnicalRiskCaps } = require('../technical_risk_caps');
const { resolveRiskPolicy } = require('../risk_policy');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');

function source(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('technical caps SSOT keeps current restrictive safe defaults', () => {
    const previousGlobal = process.env.SYSTEM_CONFIG_GLOBAL_ROUTER_CAP;
    const previousBridge = process.env.SYSTEM_CONFIG_PER_BRIDGE_CAP;
    delete process.env.SYSTEM_CONFIG_GLOBAL_ROUTER_CAP;
    delete process.env.SYSTEM_CONFIG_PER_BRIDGE_CAP;
    try {
        const caps = getTechnicalRiskCaps();
        assert.deepEqual(caps, {
            global_router_cap: 20,
            per_bridge_cap: 5
        });
        assert.equal(Object.isFrozen(caps), true);
    } finally {
        if (previousGlobal === undefined) delete process.env.SYSTEM_CONFIG_GLOBAL_ROUTER_CAP;
        else process.env.SYSTEM_CONFIG_GLOBAL_ROUTER_CAP = previousGlobal;
        if (previousBridge === undefined) delete process.env.SYSTEM_CONFIG_PER_BRIDGE_CAP;
        else process.env.SYSTEM_CONFIG_PER_BRIDGE_CAP = previousBridge;
    }
});

test('risk policy consumes technical caps from SSOT snapshot', () => {
    const policy = resolveRiskPolicy({
        configJson: { stop_loss: 30, stop_win: 50 },
        technicalCaps: { global_router_cap: 12.5, per_bridge_cap: 3.25 }
    });
    assert.equal(policy.valid, true);
    assert.deepEqual(policy.technical_caps, {
        global_exposure: 12.5,
        per_bridge_exposure: 3.25
    });
});

test('router and live bridge consume runtime SSOT instead of launcher cap variables', () => {
    const router = source(path.join('scripts', 'signal_router.js'));
    const bridge = source(path.join('scripts', 'run_live_bridge.js'));
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const supervisorLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');

    assert.match(router, /getTechnicalRiskCaps/);
    assert.match(bridge, /getTechnicalRiskCaps/);
    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=/);
    assert.doesNotMatch(supervisorLauncher, /LIVE_BRIDGE_MAX_EXPOSURE=/);
    assert.match(routerLauncher, /run_with_system_config\.js scripts\\signal_router\.js/);
    assert.match(supervisorLauncher, /run_with_system_config\.js scripts\\master_supervisor\.js/);
});

test('financial dry run remains inviolable through DB config runner', () => {
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const runner = source(path.join('scripts', 'run_with_system_config.js'));
    const configService = source('system_config_service.js');

    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=/);
    assert.match(runner, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN:\s*'true'/);
    assert.match(configService, /financial_dry_run:\s*true/);
    assert.match(configService, /FINANCIAL_DRY_RUN_FORCED_TRUE/);
});
