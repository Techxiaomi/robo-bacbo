'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');
const bridgePath = path.join(root, 'scripts', 'run_live_bridge.js');
const pythonBridgePath = path.join(repoRoot, 'robo-sync-pilot', 'live_bridge.py');

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

test('stdin control thread bypasses BufferedReader during daemon shutdown', () => {
    const text = fs.readFileSync(pythonBridgePath, 'utf8');
    const controlLoop = text.match(/def _stdin_control_loop\(\):([\s\S]*?)\n\ndef _required_nested/);
    assert.ok(controlLoop, 'stdin control loop must remain explicit');
    assert.match(controlLoop[1], /control_stream\s*=\s*sys\.stdin\.buffer\.raw/);
    assert.match(controlLoop[1], /control_stream\.readline\(MAX_CONTROL_LINE_BYTES \+ 1\)/);
    assert.doesNotMatch(controlLoop[1], /sys\.stdin\.buffer\.readline/);
});

test('fault diagnostics do not change financial or browser parameters', () => {
    const text = source();
    assert.doesNotMatch(text, /chromium\.launch|BROWSER_ARGS/);
    assert.match(text, /technical_caps_enabled:\s*technicalCaps\.enabled === true/);
    assert.match(text, /max_exposure:\s*technicalCaps\.configured_per_bridge_cap/);
});
