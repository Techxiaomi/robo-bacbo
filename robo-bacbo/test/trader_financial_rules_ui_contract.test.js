'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('UI financeira carrega contrato do catálogo seguro e não hardcodeia regra operacional', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'trader-financial-rules-ui.js'), 'utf8');
    assert.match(source, /\/api\/trader-account-catalog/);
    assert.match(source, /financial_rules/);
    assert.match(source, /rules\.min_stake/);
    assert.match(source, /rules\.stake_step/);
    assert.match(source, /rules\.tie_min/);
    assert.match(source, /rules\.tie_step/);
    assert.match(source, /rules\.chips/);
    assert.match(source, /container\.replaceChildren/);
    assert.match(source, /atualizarPreviewProtecaoEmpateAutoTrader/);
});

test('loader instala UI table-aware depois do script principal do painel', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(source, /trader-financial-rules-ui\.js/);
    const dashboardAppend = source.indexOf('document.body.appendChild(script);');
    const install = source.indexOf('window.__traderFinancialRulesUi.install()');
    assert.ok(dashboardAppend >= 0);
    assert.ok(install > dashboardAppend);
});

test('catálogo seguro expõe exatamente o contrato financeiro da mesa runtime', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'trader_account_catalog.js'), 'utf8');
    assert.match(source, /publicTableFinancialRules/);
    assert.match(source, /financial_rules: publicTableFinancialRules\(mesa\.codigo\)/);
});

test('bootstrap instala bridge e gate table-aware antes de carregar backend legado', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
    const bridge = source.indexOf('installTableAwareConfigValidationBridge();');
    const guard = source.indexOf('installTableFinancialRulesGuard();');
    const multiAccountRequire = source.indexOf("require('./multi_account_financial_authorization')");
    const bot2 = source.indexOf("require('./bot2_coletor');");
    assert.ok(bridge >= 0);
    assert.ok(guard > bridge);
    assert.ok(multiAccountRequire > guard);
    assert.ok(bot2 > multiAccountRequire);
});
