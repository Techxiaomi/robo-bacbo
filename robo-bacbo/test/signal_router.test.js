'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeSignal,
    buildTargetIndex,
    deterministicOrderId,
    commandForTarget,
    calculateGlobalExposure,
    resolveOnlineTargets,
    fanInTargets,
    registerFanInExpectation,
    buildDryRunConsolidated,
    RedisSignalDedup
} = require('../scripts/signal_router');

test('normaliza sync_balance global para uma mesa', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'sync-001',
        action: 'sync_balance',
        table: 'BACBO_BR'
    }));

    assert.deepEqual(signal, {
        signal_id: 'sync-001',
        action: 'sync_balance',
        table_key: 'bacbo_br'
    });
});

test('place_bet permanece bloqueado sem chave financeira', () => {
    assert.throws(
        () => normalizeSignal(JSON.stringify({
            signal_id: 'bet-001',
            action: 'place_bet',
            table_key: 'bacbo_br',
            alvo: 'PlayerWon',
            valor_base: 5
        })),
        /SIGNAL_ROUTER_FINANCIAL_ACTION_BLOCKED/
    );
});

test('normaliza place_bet somente quando chave financeira esta habilitada', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'bet-002',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'PlayerWon',
        valor_base: 5
    }), { financialEnabled: true });

    assert.equal(signal.action, 'place_bet');
    assert.equal(signal.alvo, 'PlayerWon');
    assert.equal(signal.valor, 5);
    assert.equal(signal.exposure_cents, 500);
});

test('indexa somente contas e mesas habilitadas', () => {
    const index = buildTargetIndex([
        {
            id: 4,
            name: 'Conta 4',
            enabled: true,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true },
                { table_key: 'bacbo_int', display_name: 'Bac Bo INT', enabled: false }
            ]
        },
        {
            id: 1,
            name: 'Conta 1',
            enabled: true,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true }
            ]
        },
        {
            id: 9,
            name: 'Conta 9',
            enabled: false,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true }
            ]
        }
    ]);

    assert.equal(index.get('bacbo_br').length, 2);
    assert.deepEqual(index.get('bacbo_br').map(item => item.account_id), [1, 4]);
    assert.equal(index.get('bacbo_br')[0].response_channel, 'auto_trader_responses:1:bacbo_br');
    assert.equal(index.get('bacbo_br')[1].response_channel, 'auto_trader_responses:4:bacbo_br');
    assert.equal(index.has('bacbo_int'), false);
});

test('gera order_id financeiro deterministico por conta', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'bet-003',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'PlayerWon',
        valor_base: 5
    }), { financialEnabled: true });
    const target1 = { account_id: 1, session_id: 'account-1:bacbo_br', table_key: 'bacbo_br' };
    const target4 = { account_id: 4, session_id: 'account-4:bacbo_br', table_key: 'bacbo_br' };

    assert.equal(deterministicOrderId(signal, target1), deterministicOrderId(signal, target1));
    assert.notEqual(deterministicOrderId(signal, target1), deterministicOrderId(signal, target4));

    const command = commandForTarget(signal, target4);
    assert.equal(command.action, 'place_bet');
    assert.equal(command.alvo, 'PlayerWon');
    assert.equal(command.valor, 5);
    assert.match(command.order_id, /^sr-[a-f0-9]{32}$/);
});

test('fanin associa order_id e response channel da mesma conta', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'bet-fanin-001',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'PlayerWon',
        valor_base: 5
    }), { financialEnabled: true });
    const targets = [
        {
            account_id: 1,
            session_id: 'account-1:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:1:bacbo_br'
        },
        {
            account_id: 4,
            session_id: 'account-4:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:4:bacbo_br'
        }
    ];

    const mapped = fanInTargets(signal, targets);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].order_id, deterministicOrderId(signal, targets[0]));
    assert.equal(mapped[0].response_channel, targets[0].response_channel);
    assert.equal(mapped[1].order_id, deterministicOrderId(signal, targets[1]));
    assert.equal(mapped[1].response_channel, targets[1].response_channel);
});

test('registro de fanin usa exatamente os alvos calculados sem dispatch', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'bet-fanin-sim-001',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'PlayerWon',
        valor_base: 5
    }), { financialEnabled: true });
    const targets = [
        {
            account_id: 1,
            session_id: 'account-1:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:1:bacbo_br'
        },
        {
            account_id: 4,
            session_id: 'account-4:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:4:bacbo_br'
        }
    ];
    let registered = null;
    const fanin = {
        register(value) { registered = value; }
    };

    const expected = registerFanInExpectation(fanin, signal, targets, 210000);
    assert.equal(expected.length, 2);
    assert.equal(registered.signalId, signal.signal_id);
    assert.equal(registered.tableKey, 'bacbo_br');
    assert.deepEqual(registered.targets, expected);
    assert.equal(expected[0].order_id, deterministicOrderId(signal, targets[0]));
    assert.equal(expected[1].order_id, deterministicOrderId(signal, targets[1]));
});

test('dry run real fecha plumbing como nao executado e sem confirmacao financeira', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: '550e8400-e29b-41d4-a716-446655440000',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'PlayerWon',
        valor_base: 5
    }), { financialEnabled: true });
    const targets = [
        {
            account_id: 1,
            session_id: 'account-1:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:1:bacbo_br'
        },
        {
            account_id: 4,
            session_id: 'account-4:bacbo_br',
            table_key: 'bacbo_br',
            response_channel: 'auto_trader_responses:4:bacbo_br'
        }
    ];

    const result = buildDryRunConsolidated(signal, targets, 123456789);
    assert.equal(result.action, 'multi_account_bet_result');
    assert.equal(result.order_id, signal.signal_id);
    assert.equal(result.table_key, 'bacbo_br');
    assert.equal(result.status, 'FAILED');
    assert.equal(result.executor_status, 'FALHOU');
    assert.equal(result.dry_run, true);
    assert.equal(result.expected_accounts, 2);
    assert.equal(result.success_accounts, 0);
    assert.equal(result.failed_accounts, 2);
    assert.equal(result.confirmacao, null);
    assert.equal(result.completed_at, 123456789);
    assert.ok(result.accounts.every(item => item.status === 'FALHOU'));
    assert.ok(result.accounts.every(item => item.motivo === 'SIGNAL_ROUTER_FINANCIAL_DRY_RUN_NO_DISPATCH'));
});

test('calcula exposicao global somente pelos alvos online', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'bet-004',
        action: 'place_bet',
        table_key: 'bacbo_br',
        alvo: 'BankerWon',
        valor_base: 5
    }), { financialEnabled: true });

    assert.equal(calculateGlobalExposure(signal, 2), 10);
    assert.equal(calculateGlobalExposure(signal, 1), 5);
    assert.equal(calculateGlobalExposure(signal, 0), 0);
});

test('resolve alvos online via PUBSUB NUMSUB', async () => {
    const client = {
        async sendCommand(command) {
            assert.deepEqual(command, [
                'PUBSUB', 'NUMSUB',
                'auto_trader_commands:1:bacbo_br',
                'auto_trader_commands:4:bacbo_br'
            ]);
            return [
                'auto_trader_commands:1:bacbo_br', 1,
                'auto_trader_commands:4:bacbo_br', 0
            ];
        }
    };
    const targets = [
        { account_id: 1, command_channel: 'auto_trader_commands:1:bacbo_br' },
        { account_id: 4, command_channel: 'auto_trader_commands:4:bacbo_br' }
    ];

    const result = await resolveOnlineTargets(client, targets);
    assert.equal(result[0].subscribers, 1);
    assert.equal(result[1].subscribers, 0);
});

test('dedup redis usa SET NX PX e rejeita signal_id ja reivindicado', async () => {
    const calls = [];
    let first = true;
    const client = {
        async set(key, value, options) {
            calls.push({ key, value, options });
            if (first) {
                first = false;
                return 'OK';
            }
            return null;
        }
    };

    const dedup = new RedisSignalDedup({
        client,
        ttlMs: 60000,
        prefix: 'signal_router:dedup:test'
    });

    assert.equal(await dedup.claim('sync-003'), true);
    assert.equal(await dedup.claim('sync-003'), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, 'signal_router:dedup:test:sync-003');
    assert.equal(calls[0].options.NX, true);
    assert.equal(calls[0].options.PX, 60000);
});
