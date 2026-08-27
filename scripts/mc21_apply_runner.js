#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const EXPECTED_BRANCH = 'fix/mc21-auto-trader-multi-robot-arbiter';
const env = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', LESS: '-FRX' };

function git(args, cwd) {
    return cp.execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
    }).trim();
}

const cwd = process.cwd();
const repoRoot = git(['rev-parse', '--show-toplevel'], cwd);
const branch = git(['branch', '--show-current'], repoRoot);
const head = git(['rev-parse', 'HEAD'], repoRoot);
const tracked = git(['status', '--porcelain=v1', '--untracked-files=no'], repoRoot);

if (branch !== EXPECTED_BRANCH) {
    throw new Error(`Branch inesperada: ${branch}`);
}
if (tracked) {
    throw new Error(`Há alterações tracked antes do MC21:\n${tracked}`);
}

const originalPath = path.join(repoRoot, 'scripts', 'mc21_apply.js');
let source = fs.readFileSync(originalPath, 'utf8');

const rxHead = /const EXPECTED_HEAD = '[0-9a-f]{40}';/;
if (!rxHead.test(source)) {
    throw new Error('Constante EXPECTED_HEAD não encontrada no aplicador.');
}
source = source.replace(rxHead, `const EXPECTED_HEAD = '${head}';`);

const oldRm = "run('git', ['rm', '--', scriptGitPath], repoRoot, 30000);";
const newRm = "run('git', ['rm', '--', scriptGitPath, 'scripts/mc21_apply_runner.js'], repoRoot, 30000);";
if (!source.includes(oldRm)) {
    throw new Error('Âncora de limpeza do aplicador não encontrada.');
}
source = source.replace(oldRm, newRm);

const tempPath = path.join(os.tmpdir(), `mc21_apply_runtime_${process.pid}.js`);
fs.writeFileSync(tempPath, source, 'utf8');

try {
    const result = cp.spawnSync(process.execPath, [tempPath], {
        cwd,
        env,
        stdio: 'inherit',
        timeout: 180000
    });

    if (result.error) throw result.error;
    process.exitCode = Number(result.status) || 0;
} finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
}
