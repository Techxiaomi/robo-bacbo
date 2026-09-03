'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeAccountIds,
    accountIdsFromConfig,
    tasksFromRows,
    metricsNamespaceForTask,
    envForTask
} = require('../trader_bound_tasks');

test('normaliza account_ids do config do trader de forma deterministica', () => {
    assert.deepEqual(normalizeAccountIds([4, '1', 4, 0, 'x']), [1, 4]);
    assert.deepEqual(accountIdsFromConfig('{"account_ids":[4,1,4]}'), [1, 4]);
    assert.deepEqual(accountIdsFromConfig({ account_ids: [7, 2] }), [2, 7]);
    assert.deepEqual(accountIdsFromConfig('{json-invalido'), []);
});

test('deduplica dois traders na mesma conta e mesa em um unico worker', () => {
    const tasks = tasksFromRows([
        {
            trader_id: 10,
            account_id: 1,
            account_name: 'Conta 1',
            table_key: 'bacbo_int',
            table_name: 'Bac Bo INT'
        },
        {
            trader_id: 11,
            account_id: 1,
            account_name: 'Conta 1',
            table_key: 'bacbo_int',
            table_name: 'Bac Bo INT'
        }
    ]);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'account-1:bacbo_int');
    assert.deepEqual(tasks[0].traderIds, [10, 11]);
});

test('mantem workers distintos por conta e mesa e respeita filtro', () => {
    const rows = [
        { trader_id: 10, account_id: 1, account_name: 'Conta 1', table_key: 'bacbo_int', table_name: 'INT' },
        { trader_id: 20, account_id: 4, account_name: 'Conta 4', table_key: 'bacbo_br', table_name: 'BR' }
    ];

    assert.equal(tasksFromRows(rows).length, 2);
    const filtered = tasksFromRows(rows, new Set(['bacbo_br']));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'account-4:bacbo_br');
});

test('gera namespace de metricas exclusivo e mesa canonica no ambiente do worker', () => {
    const task = {
        accountId: 4,
        tableKey: 'bacbo_br'
    };
    assert.equal(metricsNamespaceForTask(task), 'account-4-bacbo_br');

    const env = envForTask({ EXISTING: 'ok' }, task);
    assert.equal(env.EXISTING, 'ok');
    assert.equal(env.BACBO_MESA_CODIGO, 'BACBO_BR');
    assert.equal(env.OPERATIONS_METRICS_NAMESPACE, 'account-4-bacbo_br');
    assert.equal(env.LIVE_BRIDGE_PROCESS_NAMESPACE, 'account-4-bacbo_br');
});
