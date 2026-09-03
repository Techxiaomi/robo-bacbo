'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    publishTerminalFinancialFailure
} = require('../scripts/signal_router');

test('terminal rejection publica FALHOU correlacionado com a ordem sem dispatch', async () => {
    const publications = [];

    const publisher = {
        async publish(channel, payload) {
            publications.push({
                channel,
                payload: JSON.parse(payload)
            });

            return 1;
        }
    };

    const signal = {
        signal_id: '681566ce-a50f-4b08-b94d-8865d2278127',
        action: 'place_bet',
        table_key: 'bacbo_int'
    };

    const result = await publishTerminalFinancialFailure({
        publisher,
        consolidatedChannel: 'global_signal_results',
        signal,
        reason:
            'SIGNAL_ROUTER_TRADER_SCOPE_REJECTED: ' +
            'EXPOSURE_REJECTED reason=PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED',
        expectedAccounts: 0
    });

    assert.equal(publications.length, 1);
    assert.equal(
        publications[0].channel,
        'global_signal_results'
    );

    assert.deepEqual(
        publications[0].payload,
        result
    );

    assert.equal(
        result.action,
        'multi_account_bet_result'
    );

    assert.equal(
        result.signal_id,
        signal.signal_id
    );

    assert.equal(
        result.order_id,
        signal.signal_id
    );

    assert.equal(
        result.table_key,
        'bacbo_int'
    );

    assert.equal(
        result.status,
        'FAILED'
    );

    assert.equal(
        result.executor_status,
        'FALHOU'
    );

    assert.equal(
        result.router_terminal_rejection,
        true
    );

    assert.equal(
        result.dry_run,
        false
    );

    assert.match(
        result.motivo,
        /PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED/
    );
});

test('todos os retornos financeiros pre-dispatch possuem terminal failure', () => {
    const source = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'scripts',
            'signal_router.js'
        ),
        'utf8'
    );

    const calls =
        source.match(
            /publishTerminalFinancialFailure\s*\(\s*\{/g
        ) || [];

    // 1 definição/uso unitário não conta aqui.
    // Precisamos de pelo menos sete chamadas nos caminhos runtime.
    assert.ok(
        calls.length >= 7,
        'faltam caminhos financeiros sem resultado terminal'
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_TRADER_SCOPE_REJECTED:[^\n]*|terminalReason/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_NO_BOUND_TARGETS/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_ONLINE_DISCOVERY_FAILED/
    );

    assert.match(
        source,
        /GLOBAL_EXPOSURE_LIMIT_EXCEEDED/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_NO_ONLINE_TARGETS/
    );
});

test('financial dry-run continua retornando antes de qualquer dispatch', () => {
    const source = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'scripts',
            'signal_router.js'
        ),
        'utf8'
    );

    const dryRunIndex =
        source.indexOf(
            'SIGNAL_ROUTER_FINANCIAL_DRY_RUN_COMPLETE'
        );

    const dispatchIndex =
        source.indexOf(
            'const results = await Promise.allSettled'
        );

    assert.ok(dryRunIndex >= 0);
    assert.ok(dispatchIndex > dryRunIndex);

    const dryRunArea =
        source.slice(
            dryRunIndex,
            dispatchIndex
        );

    assert.match(
        dryRunArea,
        /return;/
    );
});
