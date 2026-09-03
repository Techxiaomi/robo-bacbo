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
    assert.match(source, /_wait_for_login_fields\(page\)/);
    assert.match(source, /_wait_for_authenticated_home\(page\)/);
    assert.match(source, /BRASIL_DA_SORTE_LOGIN_FORM_READY=true/);
    assert.match(source, /BRASIL_DA_SORTE_LOGIN_FORM_OPENED=true/);
});

test('fast adapter performs only one HOME overlay pass before login trigger', () => {
    const source = read(adapterPath);
    const performStart = source.indexOf('    def _perform_login');
    const openStart = source.indexOf('    def _open_login_form');
    const gameStart = source.indexOf('    def _wait_and_launch_game');
    assert.ok(performStart > 0 && openStart > performStart && gameStart > openStart);

    const performBlock = source.slice(performStart, openStart);
    const openBlock = source.slice(openStart, gameStart);
    assert.doesNotMatch(performBlock, /_dismiss_prelaunch_overlays/);
    assert.doesNotMatch(performBlock, /_find_login_fields\(page\)/);
    assert.doesNotMatch(openBlock, /_dismiss_prelaunch_overlays/);
    assert.match(source, /BRASIL_DA_SORTE_POPUPS_CHECK_DONE=true/);
    assert.match(source, /BRASIL_DA_SORTE_SESSION_PROBE_DONE=/);
    assert.match(source, /BRASIL_DA_SORTE_LOGIN_BUTTON_FOUND=/);
});

test('game launch skips redundant scroll and replaces fixed settle with bounded polling', () => {
    const source = read(adapterPath);
    const gameStart = source.indexOf('    def _wait_and_launch_game');
    assert.ok(gameStart > 0);
    const gameBlock = source.slice(gameStart);
    assert.doesNotMatch(gameBlock, /\bcandidate\.scroll_into_view_if_needed\s*\(/);
    assert.match(gameBlock, /candidate\.click\(force=True, timeout=3000\)/);
    assert.match(gameBlock, /_wait_for_game_transition\(primary_page\)/);
    assert.match(gameBlock, /while elapsed < GAME_LAUNCH_SETTLE_MS/);
    assert.match(gameBlock, /interval_ms = 100/);
    assert.match(gameBlock, /BRASIL_DA_SORTE_PLAY_TRANSITION_READY_MS=/);
});

test('adapter registry selects the reactive adapter without financial overrides', () => {
    const source = read(registryPath);
    assert.match(source, /from adapters_py\.brasil_da_sorte_fast import BrasilDaSorteFastAdapter/);
    assert.match(source, /"brasil-da-sorte": BrasilDaSorteFastAdapter/);
    assert.match(source, /ADAPTER_REGISTRY_FINANCIAL_OVERRIDE_FORBIDDEN/);
});

test('startup tracker recognizes the reactive pre-login and game-transition stages', () => {
    const source = read(trackerPath);
    assert.match(source, /HOME_NAVIGATED/);
    assert.match(source, /POPUPS_CHECK_DONE/);
    assert.match(source, /SESSION_PROBE_DONE/);
    assert.match(source, /LOGIN_BUTTON_FOUND/);
    assert.match(source, /LOGIN_FORM_OPENED/);
    assert.match(source, /LOGIN_FORM_READY/);
    assert.match(source, /PLAY_TRANSITION_READY/);
    assert.match(source, /PLAY_TRANSITION_WAIT_EXHAUSTED/);
});
