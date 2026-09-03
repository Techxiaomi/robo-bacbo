'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const diagnosticPath = path.join(repoRoot, 'robo-sync-pilot', 'sitecustomize.py');

function source() {
    return fs.readFileSync(diagnosticPath, 'utf8');
}

test('fault diagnostics only arm for live_bridge.py', () => {
    const text = source();
    assert.match(text, /Path\(str\(values\[0\]\)\)\.name\.lower\(\) == "live_bridge\.py"/);
    assert.match(text, /if not _is_live_bridge_process\(\):\s*\n\s*return False/);
});

test('fault diagnostics persist native traceback with all threads', () => {
    const text = source();
    assert.match(text, /live-bridge-python-fault-\{os\.getpid\(\)\}\.log/);
    assert.match(text, /faulthandler\.enable\(file=_fault_file, all_threads=True\)/);
    assert.match(text, /LIVE_BRIDGE_FAULTHANDLER_ENABLED/);
});

test('fault diagnostics do not alter bridge financial or browser code', () => {
    const text = source();
    assert.doesNotMatch(text, /place_bet|REDIS_COMMAND_CHANNEL|chromium\.launch|BROWSER_ARGS|AUTO_TRADER/);
});
