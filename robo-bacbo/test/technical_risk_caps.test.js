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

test('technical caps SSOT keeps current restrictive values', () => {
    const caps = getTechnicalRiskCaps();
    assert.deepEqual(caps, {
        global_router_cap: 20,
        per_bridge_cap: 5
    });
    assert.equal(Object.isFrozen(caps), true);
});

test('risk policy consumes technical caps from SSOT', () => {
    const policy = resolveRiskPolicy({
        configJson: { stop_loss: 30, stop_win: 50 }
    });
    assert.equal(policy.valid, true);
    assert.deepEqual(policy.technical_caps, {
        global_exposure: 20,
        per_bridge_exposure: 5
    });
});

test('router and live bridge consume SSOT instead of launcher cap variables', () => {
    const router = source(path.join('scripts', 'signal_router.js'));
    const bridge = source(path.join('scripts', 'run_live_bridge.js'));
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const supervisorLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');

    assert.match(router, /getTechnicalRiskCaps/);
    assert.match(router, /SIGNAL_ROUTER_TECHNICAL_CAP_SOURCE=technical_risk_caps/);
    assert.match(bridge, /getTechnicalRiskCaps/);
    assert.match(bridge, /LIVE_BRIDGE_TECHNICAL_CAP_SOURCE=technical_risk_caps/);

    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=/);
    assert.doesNotMatch(supervisorLauncher, /LIVE_BRIDGE_MAX_EXPOSURE=/);
});

test('financial dry run remains inviolable in launcher', () => {
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    assert.match(routerLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/);
    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=false/);
});
