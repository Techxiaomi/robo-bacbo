'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SAFE_DEFAULTS, readSystemConfig, updateTechnicalCaps } = require('../system_config_service');

function poolWithRows(rows = []) {
    return {
        async query(sql) {
            if (/SELECT config_key, config_value/.test(sql)) return [rows];
            return [{ affectedRows: 1 }];
        }
    };
}

test('empty DB resolves to safe defaults with dry run forced true', async () => {
    const config = await readSystemConfig({ dbPool: poolWithRows([]) });
    assert.equal(config.global_router_cap, 20);
    assert.equal(config.per_bridge_cap, 5);
    assert.equal(config.financial_dry_run, true);
});

test('DB caps are dynamic but cannot exceed safe ceilings', async () => {
    const config = await readSystemConfig({
        dbPool: poolWithRows([
            { config_key: 'global_router_cap', config_value: '12.50' },
            { config_key: 'per_bridge_cap', config_value: '3.25' },
            { config_key: 'financial_dry_run', config_value: 'true' }
        ])
    });
    assert.equal(config.global_router_cap, 12.5);
    assert.equal(config.per_bridge_cap, 3.25);
    assert.equal(config.financial_dry_run, true);
});

test('attempt to persist cap above safe ceiling is rejected', async () => {
    await assert.rejects(
        () => updateTechnicalCaps({ dbPool: poolWithRows([]), globalRouterCap: SAFE_DEFAULTS.global_router_cap + 1, perBridgeCap: 5 }),
        /SYSTEM_CONFIG_GLOBAL_ROUTER_CAP_INVALID/
    );
    await assert.rejects(
        () => updateTechnicalCaps({ dbPool: poolWithRows([]), globalRouterCap: 20, perBridgeCap: SAFE_DEFAULTS.per_bridge_cap + 1 }),
        /SYSTEM_CONFIG_PER_BRIDGE_CAP_INVALID/
    );
});

test('stored dry run false is overridden fail-closed to true', async () => {
    const config = await readSystemConfig({
        dbPool: poolWithRows([
            { config_key: 'global_router_cap', config_value: '20' },
            { config_key: 'per_bridge_cap', config_value: '5' },
            { config_key: 'financial_dry_run', config_value: 'false' }
        ])
    });
    assert.equal(config.financial_dry_run, true);
    assert.equal(config.dry_run_forced, true);
    assert.equal(config.fail_closed, true);
});

test('launchers contain no risk cap or dry-run value and use DB config runner', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const routerLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    const supervisorLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run_with_system_config.js'), 'utf8');

    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=/);
    assert.doesNotMatch(routerLauncher, /SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=/);
    assert.doesNotMatch(supervisorLauncher, /LIVE_BRIDGE_MAX_EXPOSURE=/);
    assert.match(routerLauncher, /run_with_system_config\.js scripts\\signal_router\.js/);
    assert.match(supervisorLauncher, /run_with_system_config\.js scripts\\master_supervisor\.js/);
    assert.match(runner, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN: 'true'/);
});

test('Acessos API allows cap updates but has no path to disable dry run', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'betting_house_api_dev_server.js'), 'utf8');
    assert.match(source, /app\.put\('\/api\/financial-safety\/system-config'/);
    assert.match(source, /FINANCIAL_DRY_RUN_DISABLE_FORBIDDEN/);
    assert.doesNotMatch(source, /financial-safety\/dry-run\/disable/);
});
