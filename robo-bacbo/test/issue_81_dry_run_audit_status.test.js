'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    erroRepresentaDryRunFinanceiro
} = require('../auto_trader_round_arbiter');

test('issue 81: reconhece apenas o terminal canônico de dry-run financeiro', () => {
    const dryRun = new Error(
        'Executor reportou FALHOU: MULTI_ACCOUNT_DRY_RUN_NO_DISPATCH: 0/2'
    );
    dryRun.status_executor = 'FALHOU';

    assert.equal(erroRepresentaDryRunFinanceiro(dryRun), true);

    const falhaReal = new Error('Executor reportou FALHOU: BRIDGE_REJECTED');
    falhaReal.status_executor = 'FALHOU';
    assert.equal(erroRepresentaDryRunFinanceiro(falhaReal), false);

    const ambiguo = new Error(
        'Executor reportou AMBIGUA: MULTI_ACCOUNT_DRY_RUN_NO_DISPATCH'
    );
    ambiguo.status_executor = 'AMBIGUA';
    assert.equal(erroRepresentaDryRunFinanceiro(ambiguo), false);
});

test('issue 81: dry-run terminal é persistido antes da classificação genérica de falha', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'auto_trader_round_arbiter.js'),
        'utf8'
    );

    const dryRunBranch = source.indexOf('if (erroRepresentaDryRunFinanceiro(e))');
    const dryRunStatus = source.indexOf("status_ordem='DRY_RUN'", dryRunBranch);
    const genericFailure = source.indexOf(
        'deps.marcarIntencaoAposFalhaEnvio(',
        dryRunBranch
    );

    assert.ok(dryRunBranch >= 0, 'ramo de dry-run deve existir');
    assert.ok(dryRunStatus > dryRunBranch, 'dry-run deve persistir status DRY_RUN');
    assert.ok(
        genericFailure > dryRunStatus,
        'classificação genérica de falha deve ocorrer somente depois do dry-run'
    );
});
