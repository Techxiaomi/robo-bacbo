'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ResultFanIn } = require('../signal_result_fanin');

function target(tableKey) {
    return {
        account_id: 4,
        session_id: `account-4:${tableKey}`,
        order_id: `sr-order-account-4-${tableKey}`,
        response_channel: `auto_trader_responses:4:${tableKey}`
    };
}

test('etapa 3: fan-in rejeita mesma ordem recebida pelo canal da mesa errada', async () => {
    const published = [];
    const expected = target('bacbo_int');
    const fanin = new ResultFanIn({
        publish: async payload => published.push(payload),
        timeoutMs: 60000
    });

    fanin.register({
        signalId: 'signal-int-001',
        tableKey: 'bacbo_int',
        targets: [expected]
    });

    const wrongTableAccepted = await fanin.accept('auto_trader_responses:4:bacbo_br', {
        action: 'bet_result',
        order_id: expected.order_id,
        status: 'EXECUTADA',
        confirmacao: { metodo: 'TESTE_MESA_ERRADA' }
    });

    assert.equal(wrongTableAccepted, false);
    assert.equal(published.length, 0);

    const correctTableAccepted = await fanin.accept(expected.response_channel, {
        action: 'bet_result',
        order_id: expected.order_id,
        status: 'EXECUTADA',
        confirmacao: { metodo: 'TESTE_CANAL_CORRETO' }
    });

    assert.ok(correctTableAccepted);
    assert.equal(published.length, 1);
    assert.equal(published[0].table_key, 'bacbo_int');
    assert.equal(published[0].status, 'FULL_SUCCESS');
    assert.equal(published[0].executor_status, 'EXECUTADA');
    assert.equal(published[0].accounts[0].session_id, 'account-4:bacbo_int');
    assert.equal(published[0].confirmacao.metodo, 'MULTI_ACCOUNT_FANIN');

    fanin.close();
});

test('etapa 3: expectativa BR nao aceita resposta equivalente no canal INT', async () => {
    const published = [];
    const expected = target('bacbo_br');
    const fanin = new ResultFanIn({
        publish: async payload => published.push(payload),
        timeoutMs: 60000
    });

    fanin.register({
        signalId: 'signal-br-001',
        tableKey: 'bacbo_br',
        targets: [expected]
    });

    assert.equal(await fanin.accept('auto_trader_responses:4:bacbo_int', {
        action: 'bet_result',
        order_id: expected.order_id,
        status: 'FALHOU',
        motivo: 'RESPOSTA_DA_MESA_ERRADA'
    }), false);
    assert.equal(published.length, 0);

    assert.ok(await fanin.accept(expected.response_channel, {
        action: 'bet_result',
        order_id: expected.order_id,
        status: 'FALHOU',
        motivo: 'FALHA_REAL_DA_MESA_CORRETA'
    }));

    assert.equal(published.length, 1);
    assert.equal(published[0].table_key, 'bacbo_br');
    assert.equal(published[0].status, 'FAILED');
    assert.equal(published[0].executor_status, 'FALHOU');
    assert.equal(published[0].accounts[0].motivo, 'FALHA_REAL_DA_MESA_CORRETA');

    fanin.close();
});
