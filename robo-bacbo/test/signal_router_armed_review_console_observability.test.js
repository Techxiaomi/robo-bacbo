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
        'signal_router_armed_review.js'
    ),
    'utf8'
);

test('armed review possui console humano', () => {
    assert.match(source, /\[ROUTER\] START/);
    assert.match(source, /\[ROUTER\] READY/);
    assert.match(source, /\[ROUTER\] RX/);
    assert.match(source, /\[ROUTER\] DROP/);
    assert.match(source, /\[ROUTER\] REVIEW/);
});

test('armed review preserva confirmacao humana', () => {
    assert.match(
        source,
        /human_confirmation_required:\s*true/
    );

    assert.match(
        source,
        /automatic_dispatch:\s*false/
    );

    assert.match(
        source,
        /PENDING_HUMAN_CONFIRMATION/
    );
});

test('armed review preserva pipeline funcional', () => {
    assert.match(
        source,
        /traderScopeResolver\.resolve\(signal\)/
    );

    assert.match(
        source,
        /filterTargetsByAccountIds\(targets, traderScope\.account_ids\)/
    );

    assert.match(
        source,
        /resolveOnlineTargets\(publisher, targets\)/
    );

    assert.match(
        source,
        /buildArmedReviewRequest/
    );

    assert.match(
        source,
        /buildReviewConsolidated/
    );
});

test('armed review possui audit JSONL', () => {
    assert.match(
        source,
        /signal-router\.audit\.jsonl/
    );

    assert.match(
        source,
        /auditArmedReview/
    );

    assert.match(
        source,
        /SIGNAL_ROUTER_FINANCIAL_ARMED_REVIEW_QUEUED/
    );
});
