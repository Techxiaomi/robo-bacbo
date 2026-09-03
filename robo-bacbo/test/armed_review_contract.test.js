'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildArmedReviewRequest,
    buildReviewConsolidated
} = require('../scripts/signal_router_armed_review');

test('ARMED_REVIEW prepara ordens por conta sem criar despacho automático', () => {
    const signal = {
        signal_id: 'sig-review-1',
        action: 'place_bet',
        table_key: 'bacbo_int',
        alvo: 'PlayerWon',
        valor: 5,
        exposure_cents: 500
    };
    const traderScope = { trader_id: 9, account_ids: [1, 4] };
    const targets = [
        {
            account_id: 1,
            account_name: 'Conta 1',
            table_key: 'bacbo_int',
            session_id: 'account-1:bacbo_int'
        },
        {
            account_id: 4,
            account_name: 'Conta 4',
            table_key: 'bacbo_int',
            session_id: 'account-4:bacbo_int'
        }
    ];

    const request = buildArmedReviewRequest({
        signal,
        traderScope,
        targets,
        globalExposure: 10,
        now: 123
    });

    assert.equal(request.review_status, 'PENDING_HUMAN_CONFIRMATION');
    assert.equal(request.financial_mode, 'ARMED_REVIEW');
    assert.equal(request.automatic_dispatch, false);
    assert.equal(request.worker_dispatch_count, 0);
    assert.equal(request.human_confirmation_required, true);
    assert.equal(request.expected_accounts, 2);
    assert.equal(request.prepared_orders.length, 2);
    assert.deepEqual(request.prepared_orders.map(item => item.account_id), [1, 4]);
    assert.ok(request.prepared_orders.every(item => typeof item.order_id === 'string'));
});

test('resultado consolidado de ARMED_REVIEW permanece REVIEW_REQUIRED e dispatch=0', () => {
    const reviewRequest = {
        signal_id: 'sig-review-2',
        table_key: 'bacbo_int',
        expected_accounts: 2
    };
    const result = buildReviewConsolidated(reviewRequest, 456);

    assert.equal(result.status, 'REVIEW_REQUIRED');
    assert.equal(result.executor_status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(result.armed_review, true);
    assert.equal(result.human_confirmation_required, true);
    assert.equal(result.automatic_dispatch, false);
    assert.equal(result.dispatch, 0);
    assert.equal(result.dry_run, false);
});

test('router de ARMED_REVIEW preserva fila de revisão e marcadores de dispatch=0', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'signal_router_armed_review.js'),
        'utf8'
    );

    assert.match(source, /SIGNAL_ROUTER_FINANCIAL_ARMED_REVIEW_QUEUED/);
    assert.match(source, /reviewQueueChannel/);
    assert.match(source, /human_confirmation_required=true/);
    assert.match(source, /dispatch=0/);
    assert.match(source, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/);
    assert.match(source, /ARMED_REVIEW_AUTOMATIC_DISPATCH_GUARD_NOT_ACTIVE/);
});
