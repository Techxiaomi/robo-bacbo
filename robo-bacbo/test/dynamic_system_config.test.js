'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SAFE_DEFAULTS,
    readSystemConfig,
    updateSystemConfig,
    resetSystemConfig
} = require('../system_config_service');

function statefulPool(initial = {}) {
    const state = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
    return {
        state,
        async query(sql, params = []) {
            if (/CREATE TABLE IF NOT EXISTS system_configs/.test(sql)) return [{ affectedRows: 0 }];
            if (/INSERT IGNORE INTO system_configs/.test(sql)) {
                if (!state.has('global_router_cap')) state.set('global_router_cap', String(params[0]));
                if (!state.has('per_bridge_cap')) state.set('per_bridge_cap', String(params[1]));
                if (!state.has('technical_risk_caps_enabled')) state.set('technical_risk_caps_enabled', String(params[2]));
                if (!state.has('financial_dry_run')) state.set('financial_dry_run', String(params[3]));
                return [{ affectedRows: 1 }];
            }
            if (/SELECT config_key, config_value/.test(sql)) {
                return [[...state.entries()].map(([config_key, config_value]) => ({ config_key, config_value }))];
            }
            if (/INSERT INTO system_configs/.test(sql)) {
                state.set('global_router_cap', String(params[0]));
                state.set('per_bridge_cap', String(params[1]));
                state.set('technical_risk_caps_enabled', String(params[2]));
                state.set('financial_dry_run', String(params[3]));
                return [{ affectedRows: 4 }];
            }
            throw new Error(`unexpected query: ${sql}`);
        }
    };
}

function silentLog() {
    const warnings = [];
    return {
        warnings,
        warn(...parts) { warnings.push(parts.join(' ')); }
    };
}

test('empty DB seeds caps disabled by default and runtime remains DRY_RUN', async () => {
    const dbPool = statefulPool();
    const config = await readSystemConfig({ dbPool, log: silentLog() });
    assert.equal(config.requested.global_router_cap, SAFE_DEFAULTS.global_router_cap);
    assert.equal(config.requested.per_bridge_cap, SAFE_DEFAULTS.per_bridge_cap);
    assert.equal(config.requested.technical_risk_caps_enabled, false);
    assert.equal(config.effective.technical_risk_caps_enabled, false);
    assert.equal(config.effective.financial_dry_run, true);
    assert.equal(config.financial_mode, 'DRY_RUN');
    assert.equal(config.human_confirmation_required, false);
    assert.equal(config.automatic_financial_dispatch, false);
});

test('homologation cap values remain editable and persist without R$20/R$5 clamp', async () => {
    const dbPool = statefulPool();
    const config = await updateSystemConfig({
        dbPool,
        globalRouterCap: 250,
        perBridgeCap: 75,
        technicalRiskCapsEnabled: true,
        financialDryRun: true,
        log: silentLog()
    });

    assert.equal(dbPool.state.get('global_router_cap'), '250.00');
    assert.equal(dbPool.state.get('per_bridge_cap'), '75.00');
    assert.equal(dbPool.state.get('technical_risk_caps_enabled'), 'true');
    assert.equal(config.effective.global_router_cap, 250);
    assert.equal(config.effective.per_bridge_cap, 75);
    assert.equal(config.effective.technical_risk_caps_enabled, true);
    assert.equal(config.clamped, false);
});

test('caps can be disabled while preserving their editable homologation values', async () => {
    const dbPool = statefulPool();
    const config = await updateSystemConfig({
        dbPool,
        globalRouterCap: 100,
        perBridgeCap: 15,
        technicalRiskCapsEnabled: false,
        financialDryRun: true,
        log: silentLog()
    });
    assert.equal(config.requested.global_router_cap, 100);
    assert.equal(config.requested.per_bridge_cap, 15);
    assert.equal(config.effective.technical_risk_caps_enabled, false);
});

test('financial_dry_run=false becomes ARMED_REVIEW without enabling automatic dispatch', async () => {
    const dbPool = statefulPool();
    const config = await updateSystemConfig({
        dbPool,
        globalRouterCap: 20,
        perBridgeCap: 5,
        technicalRiskCapsEnabled: false,
        financialDryRun: false,
        log: silentLog()
    });

    assert.equal(dbPool.state.get('financial_dry_run'), 'false');
    assert.equal(config.requested.financial_dry_run, false);
    assert.equal(config.requested.financial_mode, 'ARMED_REVIEW');
    assert.equal(config.financial_mode, 'ARMED_REVIEW');
    assert.equal(config.effective.financial_dry_run, true);
    assert.equal(config.financial_dry_run, true);
    assert.equal(config.human_confirmation_required, true);
    assert.equal(config.automatic_financial_dispatch, false);
    assert.equal(config.dry_run_forced, false);
    assert.equal(config.fail_closed, false);
    assert.equal(config.clamped, false);
});

test('invalid administrative types are rejected before persistence', async () => {
    const dbPool = statefulPool();
    await assert.rejects(
        () => updateSystemConfig({ dbPool, globalRouterCap: 0, perBridgeCap: 5, technicalRiskCapsEnabled: false, financialDryRun: true }),
        /SYSTEM_CONFIG_GLOBAL_ROUTER_CAP_INVALID/
    );
    await assert.rejects(
        () => updateSystemConfig({ dbPool, globalRouterCap: 20, perBridgeCap: 'x', technicalRiskCapsEnabled: false, financialDryRun: true }),
        /SYSTEM_CONFIG_PER_BRIDGE_CAP_INVALID/
    );
    await assert.rejects(
        () => updateSystemConfig({ dbPool, globalRouterCap: 20, perBridgeCap: 5, technicalRiskCapsEnabled: 'maybe', financialDryRun: true }),
        /SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED_INVALID/
    );
});

test('DELETE/reset restores caps disabled and DRY_RUN', async () => {
    const dbPool = statefulPool({
        global_router_cap: '250.00',
        per_bridge_cap: '75.00',
        technical_risk_caps_enabled: 'true',
        financial_dry_run: 'false'
    });
    const config = await resetSystemConfig({ dbPool, log: silentLog() });
    assert.equal(dbPool.state.get('global_router_cap'), SAFE_DEFAULTS.global_router_cap.toFixed(2));
    assert.equal(dbPool.state.get('per_bridge_cap'), SAFE_DEFAULTS.per_bridge_cap.toFixed(2));
    assert.equal(dbPool.state.get('technical_risk_caps_enabled'), 'false');
    assert.equal(dbPool.state.get('financial_dry_run'), 'true');
    assert.equal(config.financial_mode, 'DRY_RUN');
});

test('launchers keep automatic dry-run guard and runner carries administrative mode', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const supervisorLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run_with_system_config.js'), 'utf8');

    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=/);
    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=/);
    assert.doesNotMatch(supervisorLauncher, /LIVE_BRIDGE_MAX_EXPOSURE=/);
    assert.match(routerLauncher, /run_with_system_config\.js scripts\\signal_router\.js/);
    assert.match(supervisorLauncher, /run_with_system_config\.js scripts\\master_supervisor_fast\.js/);
    assert.match(runner, /SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED/);
    assert.match(runner, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN: 'true'/);
    assert.match(runner, /SIGNAL_ROUTER_FINANCIAL_MODE: financialMode/);
    assert.match(runner, /signal_router_armed_review\.js/);
});

test('Acessos exposes ARMED_REVIEW toggle and explicit human-confirmation warning', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'betting_house_api_dev_server.js'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'risk-policy-admin.js'), 'utf8');

    assert.match(server, /app\.get\('\/api\/financial-safety\/system-config'/);
    assert.match(server, /app\.put\('\/api\/financial-safety\/system-config'/);
    assert.match(server, /FINANCIAL_MODE_AUDIT/);
    assert.match(ui, /cfg-armed-review/);
    assert.match(ui, /ARMADO — CONFIRMAÇÃO HUMANA OBRIGATÓRIA/);
    assert.match(ui, /financial_dry_run: !armedReviewInput\.checked/);
    assert.match(ui, /automatic_financial_dispatch/);
    assert.match(ui, /method: 'DELETE'/);
});
