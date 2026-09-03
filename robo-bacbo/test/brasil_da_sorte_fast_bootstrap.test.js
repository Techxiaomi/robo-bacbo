'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(repoRoot, 'robo-sync-pilot', 'adapters_py', 'brasil_da_sorte_fast.py');
const registryPath = path.join(repoRoot, 'robo-sync-pilot', 'adapters_py', 'registry.py');
const trackerPath = path.join(__dirname, '..', 'live_bridge_startup_tracker.js');

function read(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

test('Brasil da Sorte fast adapter removes blind login sleeps but preserves polling gates', () => {
    const source = read(adapterPath);
    assert.match(source, /class BrasilDaSorteFastAdapter\(BrasilDaSorteAdapter\)/);
    assert.doesNotMatch(source, /wait_for_timeout\(1000\)/);
    assert.doesNotMatch(source, /wait_for_timeout\(2500\)/);
    assert.match(source, /_wait_for_login_fields\(page\)/);
    assert.match(source, /_wait_for_authenticated_home\(page\)/);
    assert.match(source, /BRASIL_DA_SORTE_LOGIN_FORM_READY=true/);
    assert.match(source, /BRASIL_DA_SORTE_LOGIN_FORM_OPENED=true/);
});

test('adapter registry selects the reactive adapter without financial overrides', () => {
    const source = read(registryPath);
    assert.match(source, /from adapters_py\.brasil_da_sorte_fast import BrasilDaSorteFastAdapter/);
    assert.match(source, /"brasil-da-sorte": BrasilDaSorteFastAdapter/);
    assert.match(source, /ADAPTER_REGISTRY_FINANCIAL_OVERRIDE_FORBIDDEN/);
});

test('startup tracker recognizes the new reactive login stages', () => {
    const source = read(trackerPath);
    assert.match(source, /HOME_NAVIGATED/);
    assert.match(source, /LOGIN_FORM_OPENED/);
    assert.match(source, /LOGIN_FORM_READY/);
});
