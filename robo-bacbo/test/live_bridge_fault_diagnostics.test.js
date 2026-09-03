'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bridgePath = path.join(root, 'scripts', 'run_live_bridge.js');

function source() {
    return fs.readFileSync(bridgePath, 'utf8');
}

test('live bridge always launches Python with faulthandler enabled', () => {
    const text = source();
    assert.match(text, /spawn\(pythonExecutable, \['-X', 'faulthandler', pythonScript\]/);
    assert.match(text, /env\.PYTHONFAULTHANDLER\s*=\s*'1'/);
    assert.match(text, /LIVE_BRIDGE_PYTHON_FAULTHANDLER=true/);
});

test('live bridge captures Python stderr instead of inheriting it', () => {
    const text = source();
    assert.match(text, /stdio:\s*\['pipe', 'pipe', 'pipe'\]/);
    assert.match(text, /child\.stderr\.on\('data', consumeStderr\)/);
    assert.match(text, /LIVE_BRIDGE_PYTHON_STDERR_TAIL=/);
    assert.match(text, /MAX_STDERR_TAIL_BYTES\s*=\s*64 \* 1024/);
});

test('fault diagnostics do not change financial or browser parameters', () => {
    const text = source();
    assert.doesNotMatch(text, /chromium\.launch|BROWSER_ARGS/);
    assert.match(text, /technical_caps_enabled:\s*technicalCaps\.enabled === true/);
    assert.match(text, /max_exposure:\s*technicalCaps\.configured_per_bridge_cap/);
});
