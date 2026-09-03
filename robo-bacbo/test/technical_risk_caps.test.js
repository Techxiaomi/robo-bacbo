'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    getTechnicalRiskCaps,
    DISABLED_TECHNICAL_RISK_CAPS
} = require('../technical_risk_caps');
const { resolveRiskPolicy } = require('../risk_policy');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');

function source(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function withEnv(values, callback) {
    const previous = {};
    for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key];
        if (value == null) delete process.env[key];
        else process.env[key] = String(value);
    }
    try { return callback(); }
    finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('technical caps ficam desabilitados por padrao sem perder valores de homologacao', () => {
    withEnv({
        SYSTEM_CONFIG_GLOBAL_ROUTER_CAP: null,
        SYSTEM_CONFIG_PER_BRIDGE_CAP: null,
        SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED: null
    }, () => {
        const caps = getTechnicalRiskCaps();
        assert.equal(caps.enabled, false);
        assert.equal(caps.configured_global_router_cap, 20);
        assert.equal(caps.configured_per_bridge_cap, 5);
        assert.equal(caps.global_router_cap, DISABLED_TECHNICAL_RISK_CAPS.global_router_cap);
        assert.equal(caps.per_bridge_cap, DISABLED_TECHNICAL_RISK_CAPS.per_bridge_cap);
        assert.equal(Object.isFrozen(caps), true);
    });
});

test('technical caps habilitados usam valores editaveis de homologacao', () => {
    withEnv({
        SYSTEM_CONFIG_GLOBAL_ROUTER_CAP: 250,
        SYSTEM_CONFIG_PER_BRIDGE_CAP: 25,
        SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED: true
    }, () => {
        const caps = getTechnicalRiskCaps();
        assert.equal(caps.enabled, true);
        assert.equal(caps.global_router_cap, 250);
        assert.equal(caps.per_bridge_cap, 25);
        assert.equal(caps.configured_global_router_cap, 250);
        assert.equal(caps.configured_per_bridge_cap, 25);
    });
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
    const runner = source(path.join('scripts', 'run_with_system_config.js'));
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const supervisorLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');

    assert.match(router, /getTechnicalRiskCaps/);
    assert.match(bridge, /getTechnicalRiskCaps/);
    assert.match(runner, /SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED/);
    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=/);
    assert.doesNotMatch(supervisorLauncher, /LIVE_BRIDGE_MAX_EXPOSURE=/);
    assert.match(routerLauncher, /run_with_system_config\.js scripts\\signal_router\.js/);
    assert.match(supervisorLauncher, /run_with_system_config\.js scripts\\master_supervisor\.js/);
});

test('live bridge propaga modo do cap e nunca envia sentinel de bypass ao Python', () => {
    const bridge = source(path.join('scripts', 'run_live_bridge.js'));
    const pythonBridge = fs.readFileSync(path.join(repoRoot, 'robo-sync-pilot', 'live_bridge.py'), 'utf8');

    assert.match(bridge, /technical_caps_enabled:\s*technicalCaps\.enabled === true/);
    assert.match(bridge, /max_exposure:\s*technicalCaps\.configured_per_bridge_cap/);
    assert.doesNotMatch(bridge, /max_exposure:\s*technicalCaps\.per_bridge_cap/);

    assert.doesNotMatch(pythonBridge, /CONTROLLED_MAX_EXPOSURE_CAP\s*=\s*5\.0/);
    assert.match(pythonBridge, /MAX_CONFIGURABLE_TECHNICAL_CAP\s*=\s*99999\.0/);
    assert.match(pythonBridge, /technical_caps_enabled = safety\.get\("technical_caps_enabled"\) is True/);
    assert.match(pythonBridge, /if technical_caps_enabled and exposure > max_exposure \+ 1e-9:/);
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
