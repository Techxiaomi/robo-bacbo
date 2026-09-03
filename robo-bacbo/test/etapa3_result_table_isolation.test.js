'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'redis_runtime_v3.js'), 'utf8');

function functionBody(name) {
    const start = source.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const next = source.indexOf('\nasync function ', start + 1);
    const end = next >= 0 ? next : source.length;
    return source.slice(start, end);
}

test('etapa 3: resultado consolidado exige table_key igual ao runtime antes de qualquer entrega', () => {
    const body = functionBody('encaminharResultadoMultiConta');
    const tableGuard = body.indexOf("String(dados.table_key || '').trim().toLowerCase() !== tableKeyRuntime()");
    const executorDelivery = body.indexOf("postNode('/executor-status'");

    assert.ok(tableGuard >= 0, 'table guard must exist');
    assert.ok(executorDelivery > tableGuard, 'table guard must run before executor-status delivery');
    assert.match(body, /if \(String\(dados\.table_key \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== tableKeyRuntime\(\)\) return false;/);
});

test('etapa 3: tableKeyRuntime preserva identidade canonica INT e BR', () => {
    assert.match(source, /codigo === 'BR' \|\| codigo === 'BACBO_BR'/);
    assert.match(source, /return 'bacbo_br'/);
    assert.match(source, /codigo === 'INT' \|\| codigo === 'BACBO_INT'/);
    assert.match(source, /return 'bacbo_int'/);
});

test('etapa 3: subscriber global delega ao filtro scoped antes de tratar resultado', () => {
    const subscribeIndex = source.indexOf('responseSubscriber.subscribe(GLOBAL_SIGNAL_RESULT_CHANNEL');
    const delegateIndex = source.indexOf('encaminharResultadoMultiConta(dados)', subscribeIndex);
    assert.ok(subscribeIndex >= 0, 'global result subscriber must exist');
    assert.ok(delegateIndex > subscribeIndex, 'subscriber must delegate to scoped result handler');
    assert.match(source.slice(subscribeIndex, delegateIndex + 80), /dados\.action !== 'multi_account_bet_result'/);
});
