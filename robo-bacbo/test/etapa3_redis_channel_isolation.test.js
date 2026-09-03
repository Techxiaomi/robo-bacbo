'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildTargetIndex,
    deterministicOrderId,
    fanInTargets,
    resolveOnlineTargets
} = require('../scripts/signal_router');

function housesFixture() {
    return [{
        id: 4,
        name: 'Conta 4',
        enabled: true,
        tables: [
            { table_key: 'bacbo_int', display_name: 'BACBO INT', enabled: true },
            { table_key: 'bacbo_br', display_name: 'BACBO BR', enabled: true }
        ]
    }];
}

function signal(tableKey) {
    return {
        signal_id: 'etapa3-channel-scope-001',
        action: 'place_bet',
        table_key: tableKey,
        alvo: 'PlayerWon',
        valor: 5,
        exposure_cents: 500
    };
}

test('mesma conta em duas mesas recebe command e response channels distintos', () => {
    const index = buildTargetIndex(housesFixture());
    const intTarget = index.get('bacbo_int')[0];
    const brTarget = index.get('bacbo_br')[0];

    assert.equal(intTarget.account_id, 4);
    assert.equal(brTarget.account_id, 4);
    assert.equal(intTarget.session_id, 'account-4:bacbo_int');
    assert.equal(brTarget.session_id, 'account-4:bacbo_br');
    assert.notEqual(intTarget.session_id, brTarget.session_id);
    assert.equal(intTarget.command_channel, 'auto_trader_commands:4:bacbo_int');
    assert.equal(brTarget.command_channel, 'auto_trader_commands:4:bacbo_br');
    assert.notEqual(intTarget.command_channel, brTarget.command_channel);
    assert.equal(intTarget.response_channel, 'auto_trader_responses:4:bacbo_int');
    assert.equal(brTarget.response_channel, 'auto_trader_responses:4:bacbo_br');
    assert.notEqual(intTarget.response_channel, brTarget.response_channel);
});

test('order id financeiro muda quando somente a mesa muda', () => {
    const index = buildTargetIndex(housesFixture());
    const intTarget = index.get('bacbo_int')[0];
    const brTarget = index.get('bacbo_br')[0];
    const intOrder = deterministicOrderId(signal('bacbo_int'), intTarget);
    const brOrder = deterministicOrderId(signal('bacbo_br'), brTarget);
    assert.match(intOrder, /^sr-[a-f0-9]{32}$/);
    assert.match(brOrder, /^sr-[a-f0-9]{32}$/);
    assert.notEqual(intOrder, brOrder);
});

test('fanin preserva response channel da mesma mesa do target', () => {
    const index = buildTargetIndex(housesFixture());
    const intTarget = index.get('bacbo_int')[0];
    const brTarget = index.get('bacbo_br')[0];
    const intFanIn = fanInTargets(signal('bacbo_int'), [intTarget]);
    const brFanIn = fanInTargets(signal('bacbo_br'), [brTarget]);
    assert.deepEqual(intFanIn.map(item => item.response_channel), ['auto_trader_responses:4:bacbo_int']);
    assert.deepEqual(brFanIn.map(item => item.response_channel), ['auto_trader_responses:4:bacbo_br']);
    assert.notEqual(intFanIn[0].order_id, brFanIn[0].order_id);
});

test('online discovery consulta exatamente os command channels scoped por mesa', async () => {
    const index = buildTargetIndex(housesFixture());
    const intTarget = index.get('bacbo_int')[0];
    const brTarget = index.get('bacbo_br')[0];
    const calls = [];
    const client = {
        async sendCommand(command) {
            calls.push(command);
            return [
                'auto_trader_commands:4:bacbo_int', '1',
                'auto_trader_commands:4:bacbo_br', '0'
            ];
        }
    };
    const result = await resolveOnlineTargets(client, [intTarget, brTarget]);
    assert.deepEqual(calls, [[
        'PUBSUB', 'NUMSUB',
        'auto_trader_commands:4:bacbo_int',
        'auto_trader_commands:4:bacbo_br'
    ]]);
    assert.equal(result[0].target.table_key, 'bacbo_int');
    assert.equal(result[0].subscribers, 1);
    assert.equal(result[1].target.table_key, 'bacbo_br');
    assert.equal(result[1].subscribers, 0);
});
