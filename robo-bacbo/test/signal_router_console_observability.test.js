'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '..',
        'scripts',
        'signal_router.js'
    ),
    'utf8'
);

test('router console possui eventos humanos principais', () => {
    assert.match(source, /\[ROUTER\] READY/);
    assert.match(source, /\[ROUTER\] RX/);
    assert.match(source, /\[ROUTER\] ROUTE/);
    assert.match(source, /\[ROUTER\] ROUTED/);
    assert.match(source, /\[ROUTER\] DROP/);
});

test('router possui audit JSONL dedicado', () => {
    assert.match(
        source,
        /signal-router\.audit\.jsonl/
    );

    assert.match(
        source,
        /auditRouter\(/
    );
});

test('detalhes operacionais continuam auditados', () => {
    assert.match(
        source,
        /SIGNAL_ROUTER_TARGET_CACHE_REFRESH/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_FINANCIAL_PRECHECK/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_DISPATCH_COMPLETE/
    );

    assert.match(
        source,
        /SIGNAL_FANIN_EXPECTING/
    );
});

test('roteamento funcional permanece presente', () => {
    assert.match(source, /normalizeSignal\(message/);
    assert.match(source, /dedup\.claim\(signal\.signal_id\)/);
    assert.match(source, /cache\.targets\(signal\.table_key\)/);
    assert.match(source, /resolveOnlineTargets\(publisher, targets\)/);
    assert.match(source, /commandForTarget\(signal, target\)/);
    assert.match(
        source,
        /publisher\.publish\(target\.command_channel/
    );
});

test('fanin e response channel permanecem presentes', () => {
    assert.match(source, /registerFanInExpectation/);
    assert.match(source, /fanin\.markDispatchFailure/);
    assert.match(source, /responseSubscriber\.pSubscribe/);
});
