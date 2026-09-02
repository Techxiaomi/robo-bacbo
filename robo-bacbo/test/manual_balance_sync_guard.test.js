'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = fs.readFileSync(path.join(__dirname, '..', 'manual_trader_balance_sync.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'trader-balance-sync-guard-ui.js'), 'utf8');
const start = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('backend manual sync é single-flight por Trader', () => {
    assert.match(backend, /inflightByTrader = new Map\(\)/);
    assert.match(backend, /saldo_sincronizacao_em_andamento/);
    assert.match(backend, /MANUAL_BALANCE_SYNC_DUPLICATE/);
    assert.match(backend, /finally \{/);
    assert.match(backend, /inflightByTrader\.delete\(key\)/);
});

test('manual sync usa apenas canais scoped e não cria carrier ATIVANDO', () => {
    assert.match(backend, /auto_trader_commands:\$\{accountId\}:\$\{key\}/);
    assert.match(backend, /auto_trader_responses:\*:\$\{key\}/);
    assert.doesNotMatch(backend, /ATIVANDO/);
    assert.doesNotMatch(backend, /bootstrap_carrier/i);
    assert.doesNotMatch(backend, /place_bet/);
});

test('manual sync exige Bridges READY e persiste somente saldo_atual do Trader', () => {
    assert.match(backend, /MANUAL_BALANCE_WORKERS_NOT_READY/);
    assert.match(backend, /SET saldo_atual=\?/);
    assert.match(backend, /WHERE id=\? AND mesa_id=\? AND ativo=true/);
});

test('UI bloqueia cliques repetidos e restaura botão em finally', () => {
    assert.match(ui, /inFlight: false/);
    assert.match(ui, /if \(state\.inFlight\)/);
    assert.match(ui, /button\.disabled = true/);
    assert.match(ui, /aria-busy/);
    assert.match(ui, /finally \{/);
    assert.match(ui, /setBusy\(false\)/);
});

test('bootstrap instala override backend e guarda UI antes do uso', () => {
    assert.match(start, /installAutoTraderStructuralIntegrity\(\);\s*installManualTraderBalanceSync\(\);/);
    assert.match(index, /trader-balance-sync-guard-ui\.js/);
    assert.match(index, /__traderAccountBindingUi\.install\(\)/);
    assert.match(index, /__traderBalanceSyncGuardUi\.install\(\)/);
    assert.ok(index.indexOf('__traderAccountBindingUi.install()') < index.indexOf('__traderBalanceSyncGuardUi.install()'));
});
