'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    taskId,
    tasksFromRows,
    metricsNamespaceForTask,
    envForTask
} = require('../trader_bound_tasks');

test('etapa 3: mesma conta em INT e BR gera task ids distintos', () => {
    assert.equal(taskId(4, 'bacbo_int'), 'account-4:bacbo_int');
    assert.equal(taskId(4, 'bacbo_br'), 'account-4:bacbo_br');
    assert.notEqual(taskId(4, 'bacbo_int'), taskId(4, 'bacbo_br'));
});

test('etapa 3: tasksFromRows preserva uma task por conta e mesa', () => {
    const tasks = tasksFromRows([
        {
            trader_id: 9,
            account_id: 4,
            account_name: 'Conta 4',
            table_key: 'bacbo_int',
            table_name: 'Bac Bo INT'
        },
        {
            trader_id: 21,
            account_id: 4,
            account_name: 'Conta 4',
            table_key: 'bacbo_br',
            table_name: 'Bac Bo BR'
        },
        {
            trader_id: 22,
            account_id: 4,
            account_name: 'Conta 4',
            table_key: 'bacbo_int',
            table_name: 'Bac Bo INT'
        }
    ]);

    assert.equal(tasks.length, 2);
    assert.deepEqual(
        tasks.map(item => ({ id: item.id, accountId: item.accountId, tableKey: item.tableKey })),
        [
            { id: 'account-4:bacbo_br', accountId: 4, tableKey: 'bacbo_br' },
            { id: 'account-4:bacbo_int', accountId: 4, tableKey: 'bacbo_int' }
        ]
    );

    const intTask = tasks.find(item => item.tableKey === 'bacbo_int');
    const brTask = tasks.find(item => item.tableKey === 'bacbo_br');
    assert.deepEqual(intTask.traderIds, [9, 22]);
    assert.deepEqual(brTask.traderIds, [21]);
});

test('etapa 3: filtro de mesa nunca reutiliza task da outra mesa', () => {
    const rows = [
        { trader_id: 9, account_id: 4, table_key: 'bacbo_int' },
        { trader_id: 21, account_id: 4, table_key: 'bacbo_br' }
    ];

    const intTasks = tasksFromRows(rows, new Set(['bacbo_int']));
    const brTasks = tasksFromRows(rows, new Set(['bacbo_br']));

    assert.deepEqual(intTasks.map(item => item.id), ['account-4:bacbo_int']);
    assert.deepEqual(brTasks.map(item => item.id), ['account-4:bacbo_br']);
    assert.equal(intTasks.some(item => item.tableKey === 'bacbo_br'), false);
    assert.equal(brTasks.some(item => item.tableKey === 'bacbo_int'), false);
});

test('etapa 3: namespaces e ambiente sao exclusivos por conta e mesa', () => {
    const baseEnv = { KEEP_ME: 'yes' };
    const intTask = { accountId: 4, tableKey: 'bacbo_int' };
    const brTask = { accountId: 4, tableKey: 'bacbo_br' };

    assert.equal(metricsNamespaceForTask(intTask), 'account-4-bacbo_int');
    assert.equal(metricsNamespaceForTask(brTask), 'account-4-bacbo_br');

    const intEnv = envForTask(baseEnv, intTask);
    const brEnv = envForTask(baseEnv, brTask);

    assert.equal(intEnv.KEEP_ME, 'yes');
    assert.equal(brEnv.KEEP_ME, 'yes');

    assert.equal(intEnv.BACBO_MESA_CODIGO, 'BACBO_INT');
    assert.equal(brEnv.BACBO_MESA_CODIGO, 'BACBO_BR');

    assert.equal(intEnv.METRICS_FILE_NAME, 'backend.metrics.account-4-bacbo_int.json');
    assert.equal(brEnv.METRICS_FILE_NAME, 'backend.metrics.account-4-bacbo_br.json');

    assert.equal(intEnv.OPERATIONS_METRICS_NAMESPACE, 'account-4-bacbo_int');
    assert.equal(brEnv.OPERATIONS_METRICS_NAMESPACE, 'account-4-bacbo_br');
    assert.equal(intEnv.LIVE_BRIDGE_PROCESS_NAMESPACE, 'account-4-bacbo_int');
    assert.equal(brEnv.LIVE_BRIDGE_PROCESS_NAMESPACE, 'account-4-bacbo_br');

    assert.notEqual(intEnv.METRICS_FILE_NAME, brEnv.METRICS_FILE_NAME);
    assert.notEqual(intEnv.LIVE_BRIDGE_PROCESS_NAMESPACE, brEnv.LIVE_BRIDGE_PROCESS_NAMESPACE);
});
