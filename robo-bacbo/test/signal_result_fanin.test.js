'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    aggregateStatus,
    executorStatusForAggregate,
    ResultFanIn
} = require('../signal_result_fanin');

function targets() {
    return [
        {
            account_id: 1,
            session_id: 'account-1:bacbo_br',
            order_id: 'sr-order-1',
            response_channel: 'auto_trader_responses:1:bacbo_br'
        },
        {
            account_id: 4,
            session_id: 'account-4:bacbo_br',
            order_id: 'sr-order-4',
            response_channel: 'auto_trader_responses:4:bacbo_br'
        }
    ];
}

test('consolida duas execucoes como FULL_SUCCESS', async () => {
    const published = [];
    const fanin = new ResultFanIn({
        publish: async payload => published.push(payload),
        timeoutMs: 60000
    });
    fanin.register({ signalId: 'sig-1', tableKey: 'bacbo_br', targets: targets() });

    await fanin.accept('auto_trader_responses:1:bacbo_br', {
        action: 'bet_result',
        order_id: 'sr-order-1',
        status: 'EXECUTADA',
        confirmacao: { metodo: 'SALDO', exposicao_esperada: 5, debito_observado: 5 }
    });
    assert.equal(published.length, 0);

    await fanin.accept('auto_trader_responses:4:bacbo_br', {
        action: 'bet_result',
        order_id: 'sr-order-4',
        status: 'EXECUTADA',
        confirmacao: { metodo: 'SALDO', exposicao_esperada: 5, debito_observado: 5 }
    });

    assert.equal(published.length, 1);
    assert.equal(published[0].status, 'FULL_SUCCESS');
    assert.equal(published[0].executor_status, 'EXECUTADA');
    assert.equal(published[0].success_accounts, 2);
    assert.equal(published[0].confirmacao.metodo, 'MULTI_ACCOUNT_FANIN');
    assert.equal(published[0].confirmacao.multi_account.exposicao_esperada_total, 10);
    fanin.close();
});

test('consolida sucesso parcial como PARTIAL_SUCCESS e AMBIGUA', async () => {
    const published = [];
    const fanin = new ResultFanIn({ publish: async payload => published.push(payload), timeoutMs: 60000 });
    fanin.register({ signalId: 'sig-2', tableKey: 'bacbo_br', targets: targets() });

    await fanin.accept('auto_trader_responses:1:bacbo_br', {
        action: 'bet_result', order_id: 'sr-order-1', status: 'EXECUTADA', confirmacao: { exposicao_esperada: 5 }
    });
    await fanin.accept('auto_trader_responses:4:bacbo_br', {
        action: 'bet_result', order_id: 'sr-order-4', status: 'FALHOU', motivo: 'DOM'
    });

    assert.equal(published[0].status, 'PARTIAL_SUCCESS');
    assert.equal(published[0].executor_status, 'AMBIGUA');
    assert.equal(published[0].success_accounts, 1);
    assert.equal(published[0].failed_accounts, 1);
    fanin.close();
});

test('ignora resposta em canal que nao pertence ao order_id esperado', async () => {
    const published = [];
    const fanin = new ResultFanIn({ publish: async payload => published.push(payload), timeoutMs: 60000 });
    fanin.register({ signalId: 'sig-3', tableKey: 'bacbo_br', targets: targets() });

    const accepted = await fanin.accept('auto_trader_responses:4:bacbo_br', {
        action: 'bet_result', order_id: 'sr-order-1', status: 'EXECUTADA'
    });
    assert.equal(accepted, false);
    assert.equal(published.length, 0);
    fanin.close();
});

test('falha de dispatch participa da consolidacao', async () => {
    const published = [];
    const fanin = new ResultFanIn({ publish: async payload => published.push(payload), timeoutMs: 60000 });
    fanin.register({ signalId: 'sig-4', tableKey: 'bacbo_br', targets: targets() });

    await fanin.markDispatchFailure('sr-order-1', 'NO_SUBSCRIBER');
    await fanin.markDispatchFailure('sr-order-4', 'PUBLISH_FAILED');

    assert.equal(published.length, 1);
    assert.equal(published[0].status, 'FAILED');
    assert.equal(published[0].executor_status, 'FALHOU');
    fanin.close();
});

test('mapeamento de status agregado permanece fail-closed', () => {
    assert.equal(aggregateStatus([{ status: 'EXECUTADA' }, { status: 'EXECUTADA' }]), 'FULL_SUCCESS');
    assert.equal(aggregateStatus([{ status: 'EXECUTADA' }, { status: 'FALHOU' }]), 'PARTIAL_SUCCESS');
    assert.equal(executorStatusForAggregate([{ status: 'TIMEOUT' }], 'FAILED'), 'AMBIGUA');
});
