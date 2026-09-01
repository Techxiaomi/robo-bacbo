'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('catalogo read-only deriva mesa runtime e nao expoe credenciais', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'trader_account_catalog.js'), 'utf8');
    assert.match(source, /GET|api\/trader-account-catalog|trader-account-catalog/);
    assert.match(source, /obterMesaRuntime/);
    assert.match(source, /h\.enabled = true/);
    assert.match(source, /t\.enabled = true/);
    assert.match(source, /brasil-da-sorte/);
    assert.doesNotMatch(source, /password_encrypted/);
    assert.doesNotMatch(source, /username AS/);
});

test('UI do Trader consome somente o catalogo seguro', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'trader-account-binding-ui.js'), 'utf8');
    assert.match(source, /\/api\/trader-account-catalog/);
    assert.doesNotMatch(source, /\/api\/betting-houses/);
    assert.match(source, /Conta\(s\) de Operação/);
    assert.match(source, /account_ids/);
});

test('bootstrap instala catalogo antes de carregar bot2', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
    const install = source.indexOf('instalarCatalogoContasAutoTrader();');
    const bot2 = source.indexOf("require('./bot2_coletor');");
    assert.ok(install >= 0);
    assert.ok(bot2 > install);
});
