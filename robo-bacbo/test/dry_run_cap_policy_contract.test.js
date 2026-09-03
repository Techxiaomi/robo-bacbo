'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const arbiterSource = fs.readFileSync(path.join(__dirname, '..', 'auto_trader_round_arbiter.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'signal_router.js'), 'utf8');

test('arbiter exposes explicit dry-run cap bypass telemetry', () => {
    assert.match(arbiterSource, /DRY_RUN_TECHNICAL_CAP_BYPASS/);
    assert.match(arbiterSource, /dry_run_cap_bypass/);
});

test('router preserves terminal dry-run before financial dispatch', () => {
    assert.match(routerSource, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN_NO_DISPATCH/);
    assert.match(routerSource, /buildDryRunConsolidated/);
});
