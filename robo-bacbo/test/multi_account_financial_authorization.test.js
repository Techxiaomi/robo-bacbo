'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    avaliarLimitesFinanceirosTrader,
    ScopedTraderBalanceAuthorization
} = require('../multi_account_financial_authorization');

function fakeDb() {
    return {
        async query() { return [[], []]; }
    };
}

test('agrega somente contas vinculadas do Trader para autorizar saldo', () => {
    const auth = new ScopedTraderBalanceAuthorization({
        dbPool: fakeDb(),
        tableKey: 'bacbo_br',
        freshnessMs: 90000,
        log: { log() {}, warn() {}, error() {} }
    });
    const now = 1_000_000;
    auth.record('auto_trader_responses:1:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 15.10 }), now);
    auth.record('auto_trader_responses:4:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 20.20 }), now);
    auth.record('auto_trader_responses:7:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 999.99 }), now);

    const snapshot = auth.snapshotForTrader({ config: { account_ids: [1, 4] } }, now + 1000);
    assert.equal(snapshot.fresco, true);
    assert.equal(snapshot.saldo_atual, 35.30);
    assert.deepEqual([...snapshot.account_ids], [1, 4]);
});

test('fail-closed se faltar saldo fresco de uma conta vinculada', () => {
    const auth = new ScopedTraderBalanceAuthorization({
        dbPool: fakeDb(),
        tableKey: 'bacbo_int',
        freshnessMs: 90000,
        log: { log() {}, warn() {}, error() {} }
    });
    const now = 2_000_000;
    auth.record('auto_trader_responses:1:bacbo_int', JSON.stringify({ action: 'balance_update', balance: 10 }), now);
    const snapshot = auth.snapshotForTrader({ config: { account_ids: [1, 4] } }, now + 1000);
    assert.equal(snapshot.fresco, false);
    assert.equal(snapshot.motivo, 'MISSING_ACCOUNT_BALANCE');
});

test('preserva Stop Win, Stop Loss e saldo valido no gate scoped', () => {
    const base = {
        saldo_inicial: 100,
        trailing_pico_lucro: 0,
        config: { stop_win: 20, stop_loss: 30, trailing_stop: false }
    };
    assert.equal(avaliarLimitesFinanceirosTrader(base, 110).permitido, true);
    assert.equal(avaliarLimitesFinanceirosTrader(base, 120).motivo, 'STOP_WIN');
    assert.equal(avaliarLimitesFinanceirosTrader(base, 70).motivo, 'STOP_LOSS');
});

test('bootstrap instala autorizador scoped antes do bot2', () => {
    const start = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
    const installIndex = start.indexOf('await installMultiAccountFinancialAuthorization()');
    const botIndex = start.indexOf("require('./bot2_coletor')");
    assert.ok(installIndex >= 0);
    assert.ok(botIndex > installIndex);
});

test('Signal Router permanece travado em dry-run', () => {
    const launcher = fs.readFileSync(path.join(__dirname, '..', '..', 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    assert.match(launcher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/i);
});
