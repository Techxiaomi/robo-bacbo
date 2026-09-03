'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');

test('system config runner explicitly allows fast supervisor entrypoint', () => {
    const runner = fs.readFileSync(path.join(root, 'scripts', 'run_with_system_config.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd'), 'utf8');

    assert.match(runner, /'scripts\/master_supervisor_fast\.js'/);
    assert.match(launcher, /run_with_system_config\.js scripts\\master_supervisor_fast\.js/);
});
