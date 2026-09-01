'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('loader inclui UI de vinculo Trader -> Conta(s)', () => {
    const html = read('public/index.html');
    assert.match(html, /trader-account-binding-ui\.js/);
    assert.match(html, /__traderAccountBindingUi\.install\(\)/);
});

test('formulario exige conta e injeta account_ids no config salvo', () => {
    const source = read('public/trader-account-binding-ui.js');
    assert.match(source, /Conta\(s\) de Operação \*/);
    assert.match(source, /Selecione ao menos uma Conta de Operação/);
    assert.match(source, /body\.config\.account_ids = selectedAccountIds\(\)/);
    assert.match(source, /\/api\/trader-account-catalog/);
    assert.match(source, /payload\.table_code/);
    assert.match(source, /payload\.accounts/);
});

test('catalogo seguro concentra filtro de adapter e mesa no backend', () => {
    const source = read('trader_account_catalog.js');
    assert.match(source, /brasil-da-sorte/);
    assert.match(source, /betting_house_tables/);
    assert.match(source, /LOWER\([a-z][a-z0-9_]*\.table_key\)\s*=\s*LOWER\(\?\)/i);
    assert.match(source, /enabled\s*=\s*true/i);

    const queryMatch = source.match(/`SELECT[\s\S]*?ORDER BY h\.id`/i);
    assert.ok(queryMatch, 'query SELECT do catalogo deve existir');
    const selectQuery = queryMatch[0];
    assert.doesNotMatch(selectQuery, /h\.username/i);
    assert.doesNotMatch(selectQuery, /h\.password_encrypted/i);
    assert.doesNotMatch(selectQuery, /password_encrypted/i);
});

test('edicao relê trader pela API para restaurar account_ids', () => {
    const source = read('public/trader-account-binding-ui.js');
    assert.match(source, /async function loadTrader\(id\)/);
    assert.match(source, /\/api\/auto-traders/);
    assert.match(source, /trader\?\.config\?\.account_ids/);
});
