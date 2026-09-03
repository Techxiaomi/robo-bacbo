'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
    OPEN_FINANCIAL_STATUSES,
    wantsActivation,
    positiveTraderId
} = require('../auto_trader_ambiguity_reactivation_guard');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('reativacao so e considerada quando ativo=true e trader id e valido', () => {
    assert.equal(wantsActivation({ body: { ativo: true } }), true);
    assert.equal(wantsActivation({ body: { ativo: 1 } }), true);
    assert.equal(wantsActivation({ body: { ativo: false } }), false);
    assert.equal(wantsActivation({ body: { ativo: 0 } }), false);
    assert.equal(positiveTraderId('18'), 18);
    assert.equal(positiveTraderId(0), null);
    assert.equal(positiveTraderId('x'), null);
});

test('guard preserva exatamente os estados financeiros abertos do MC21', () => {
    assert.deepEqual(
        OPEN_FINANCIAL_STATUSES,
        ['PREPARANDO', 'PENDENTE', 'ENVIO_AMBIGUO']
    );

    const source = read('auto_trader_ambiguity_reactivation_guard.js');
    assert.match(source, /status_ordem IN \('PREPARANDO','PENDENTE','ENVIO_AMBIGUO'\)/);
    assert.match(source, /AUTO_TRADER_REACTIVATION_BLOCKED_OPEN_ORDER/);
    assert.match(source, /res\.status\(409\)/);
    assert.match(source, /ordem_financeira_aberta/);
});

test('bloqueio antigo de ambiguidade pode ser limpo apenas quando open_orders=0', () => {
    const source = read('auto_trader_ambiguity_reactivation_guard.js');
    assert.match(source, /BLOQUEADO_AMBIGUIDADE/);
    assert.match(source, /AUTO_TRADER_AMBIGUITY_BLOCK_CLEARED_ON_REACTIVATION/);
    assert.match(source, /open_orders=0/);
    assert.match(source, /reactivation_guard_unavailable/);
});

test('guard de ambiguidade e instalado antes do bootstrap de ativacao e do backend', () => {
    const source = read('start.js');
    const guardIndex = source.indexOf('installAutoTraderAmbiguityReactivationGuard();');
    const bootstrapIndex = source.indexOf('installActivationBootstrap();');
    const backendIndex = source.indexOf("require('./bot2_coletor')");

    assert.ok(guardIndex >= 0, 'guard de ambiguidade deve ser instalado');
    assert.ok(bootstrapIndex > guardIndex, 'guard deve envolver a ativacao antes do bootstrap');
    assert.ok(backendIndex > bootstrapIndex, 'backend deve registrar a rota depois dos guards');
});
