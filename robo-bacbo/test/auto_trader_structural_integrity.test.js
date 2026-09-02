'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    normalizeAccountIds,
    workersReady,
    synchronizeBindings
} = require('../auto_trader_structural_integrity');

test('normalizes account ids deterministically without cross-account leakage', () => {
    assert.deepEqual(
        normalizeAccountIds({ account_ids: [4, '1', 4, 0, -1, 'x', 7] }),
        [1, 4, 7]
    );
    assert.deepEqual(normalizeAccountIds({ account_ids: [] }), []);
});

test('binding synchronization updates config and relational rows in one transaction', async () => {
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push(['begin']); },
        async query(sql, params) {
            calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
            if (/SELECT id FROM auto_traders/.test(sql)) return [[{ id: 9 }]];
            return [{ affectedRows: 1 }];
        },
        async commit() { calls.push(['commit']); },
        async rollback() { calls.push(['rollback']); },
        release() { calls.push(['release']); }
    };
    const pool = { async getConnection() { return connection; } };
    const canonical = {
        config: { account_ids: [1, 4], stop_loss: 100 },
        accountIds: [1, 4]
    };

    await synchronizeBindings(9, 2, canonical, pool);

    assert.equal(calls[0][0], 'begin');
    assert.ok(calls.some(call => String(call[0]).includes('UPDATE auto_traders SET config_json=?')));
    assert.ok(calls.some(call => String(call[0]).includes('DELETE FROM auto_trader_account_bindings')));
    const inserts = calls.filter(call => String(call[0]).includes('INSERT INTO auto_trader_account_bindings'));
    assert.deepEqual(inserts.map(call => call[1]), [[9, 1], [9, 4]]);
    assert.ok(calls.some(call => call[0] === 'commit'));
    assert.equal(calls.some(call => call[0] === 'rollback'), false);
});

test('worker readiness requires every requested scoped bridge READY', () => {
    const base = {
        available: true,
        stale: false,
        supervisor: { running: true },
        workers: [
            { session_id: 'account-1:bacbo_int', desired: true, status: 'READY' },
            { session_id: 'account-4:bacbo_int', desired: true, status: 'READY' },
            { session_id: 'account-7:bacbo_int', desired: true, status: 'READY' }
        ]
    };
    assert.equal(workersReady(base, [1, 4], 'bacbo_int'), true);
    assert.equal(workersReady(base, [1, 8], 'bacbo_int'), false);
    assert.equal(workersReady({ ...base, stale: true }, [1, 4], 'bacbo_int'), false);
});

test('structural source keeps active creation and manual sync on balance-only scoped flow', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'auto_trader_structural_integrity.js'),
        'utf8'
    );

    assert.match(source, /status_operacao\)\s*VALUES \(\?, \?, false, \?, 0, 0, 'ATIVANDO'\)/);
    assert.match(source, /AUTO_TRADER_CREATE_ACTIVE_READY/);
    assert.match(source, /MULTI_ACCOUNT_CREATE_BOOTSTRAP/);
    assert.match(source, /auto_trader_commands:\$\{accountId\}:\$\{tableKey\}/);
    assert.match(source, /action: 'sync_balance'/);
    assert.doesNotMatch(source, /action: 'place_bet'/);
    assert.match(source, /\/api\/auto-trader\/:id\/sync-balance/);
    assert.match(source, /UPDATE auto_traders SET saldo_atual=\?/);
    assert.match(source, /AUTO_TRADER_MANUAL_BALANCE_SYNC/);
});

test('catalog route is anchored to existing auto-traders route and public SELECT remains credential-free', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'trader_account_catalog.js'),
        'utf8'
    );

    assert.match(source, /path === '\/api\/auto-traders'/);
    assert.match(source, /AUTH_ORDER_ANCHORED/);
    assert.match(source, /\/api\/trader-account-catalog/);
    const selectQuery = source.match(/`SELECT[\s\S]*?ORDER BY h\.id`/i)?.[0] || '';
    assert.ok(selectQuery, 'catalog SELECT must exist');
    assert.doesNotMatch(selectQuery, /username|password|credential|cookie|senha/i);
});

test('UI manual balance button targets edited trader and never uses legacy global balance endpoint', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'trader-account-binding-ui.js'),
        'utf8'
    );

    assert.match(source, /editingTraderId/);
    assert.match(source, /\/api\/auto-trader\/\$\{traderId\}\/sync-balance/);
    assert.match(source, /method: 'POST'/);
    assert.doesNotMatch(source, /\/api\/saldo-global/);
});

test('startup installs structural integrity before bot2 registration', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
    const activationIndex = source.indexOf('installActivationBootstrap();');
    const continuousIndex = source.indexOf('await installContinuousTraderBalance();');
    const structuralIndex = source.indexOf('installAutoTraderStructuralIntegrity();');
    const botIndex = source.indexOf("require('./bot2_coletor');");

    assert.ok(activationIndex >= 0);
    assert.ok(continuousIndex > activationIndex);
    assert.ok(structuralIndex > continuousIndex);
    assert.ok(botIndex > structuralIndex);
});
