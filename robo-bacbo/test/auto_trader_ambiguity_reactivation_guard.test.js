'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
    OPEN_FINANCIAL_STATUSES,
    AUTO_RECONCILE_METHOD,
    wantsActivation,
    positiveTraderId,
    ambiguityHasExecutionEvidence,
    traderIsAmbiguityBlocked
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

test('somente ENVIO_AMBIGUO sem qualquer evidencia pode ser auto reconciliado', () => {
    assert.equal(AUTO_RECONCILE_METHOD, 'AUTO_REACTIVATION_NO_EVIDENCE');
    assert.equal(ambiguityHasExecutionEvidence({}), false);
    assert.equal(ambiguityHasExecutionEvidence({ executor_confirmacao_metodo: null }), false);
    assert.equal(ambiguityHasExecutionEvidence({ executor_confirmacao_metodo: 'SALDO_DEBITO' }), true);
    assert.equal(ambiguityHasExecutionEvidence({ executor_saldo_antes: 100 }), true);
    assert.equal(ambiguityHasExecutionEvidence({ executor_saldo_depois: 90 }), true);
    assert.equal(ambiguityHasExecutionEvidence({ executor_debito_observado: 10 }), true);
    assert.equal(ambiguityHasExecutionEvidence({ execucao_confirmada_em: 123 }), true);
    assert.equal(ambiguityHasExecutionEvidence({ resultado_confirmado_em: 123 }), true);
    assert.equal(ambiguityHasExecutionEvidence({ saldo_pos_confirmado_em: 123 }), true);

    const source = read('auto_trader_ambiguity_reactivation_guard.js');
    assert.match(source, /status_ordem='ENVIO_AMBIGUO'/);
    assert.match(source, /executor_confirmacao_metodo IS NULL/);
    assert.match(source, /executor_saldo_antes IS NULL/);
    assert.match(source, /executor_saldo_depois IS NULL/);
    assert.match(source, /executor_debito_observado IS NULL/);
    assert.match(source, /execucao_confirmada_em IS NULL/);
    assert.match(source, /resultado_confirmado_em IS NULL/);
    assert.match(source, /saldo_pos_confirmado_em IS NULL/);
    assert.match(source, /SET status_ordem='FALHOU'/);
    assert.match(source, /AUTO_TRADER_AMBIGUITY_AUTO_RECONCILED/);
});

test('auto reconciliacao so roda para trader realmente bloqueado por ambiguidade', () => {
    assert.equal(traderIsAmbiguityBlocked({ ativo: false, status_operacao: 'BLOQUEADO_AMBIGUIDADE' }), true);
    assert.equal(traderIsAmbiguityBlocked({ ativo: 0, status_operacao: 'bloqueado_ambiguidade' }), true);
    assert.equal(traderIsAmbiguityBlocked({ ativo: true, status_operacao: 'BLOQUEADO_AMBIGUIDADE' }), false);
    assert.equal(traderIsAmbiguityBlocked({ ativo: false, status_operacao: 'STANDBY' }), false);
});

test('reconciliacao e transacional e revalida ordens abertas antes de liberar', () => {
    const source = read('auto_trader_ambiguity_reactivation_guard.js');
    assert.match(source, /beginTransaction\(\)/);
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /reconcileEmptyAmbiguities/);
    assert.match(source, /await connection\.commit\(\)/);
    assert.match(source, /await connection\.rollback\(\)/);
    assert.match(source, /AUTO_TRADER_AMBIGUITY_RECONCILE_CONFLICT/);
});

test('bloqueio antigo de ambiguidade e limpo quando nao resta ordem aberta', () => {
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
