'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const switcher = fs.readFileSync(path.join(root, 'public', 'mesa-switcher.js'), 'utf8');

test('MC25: bootstrap carrega e monta o switcher depois do dashboard', () => {
    assert.match(loader, /<script src="\/mesa-switcher\.js"><\/script>/);
    assert.match(loader, /window\.__mesaSwitcherReady !== true/);
    assert.match(loader, /window\.__mesaSwitcher\?\.mount/);
    assert.match(loader, /window\.__mesaSwitcher\.mount\(\)/);

    const posBody = loader.indexOf('document.body.replaceChildren(');
    const posMount = loader.indexOf('window.__mesaSwitcher.mount()');
    assert.ok(posBody >= 0, 'dashboard deve montar o body');
    assert.ok(posMount > posBody, 'switcher deve montar depois do body real');
});

test('MC25: alternancia preserva runtimes separados e usa a mesma aba', () => {
    assert.match(switcher, /BACBO_INT:[\s\S]*?porta: '3000'/);
    assert.match(switcher, /BACBO_BR:[\s\S]*?porta: '3001'/);
    assert.match(switcher, /const porta = String\(window\.location\.port \|\| ''\)/);
    assert.match(switcher, /const url = new URL\(window\.location\.href\)/);
    assert.match(switcher, /url\.port = destino\.porta/);
    assert.match(switcher, /window\.location\.assign\(url\.toString\(\)\)/);

    assert.doesNotMatch(switcher, /definirMesaRuntime/);
    assert.doesNotMatch(switcher, /BACBO_MESA_CODIGO\s*=/);
    assert.doesNotMatch(switcher, /fetch\([^\n]*place_bet/);
});

test('MC25: identidade visual diferencia INT e BR de forma permanente', () => {
    assert.match(switcher, /document\.title = `\[\$\{mesa\.sigla\}\] Inteligência Bac Bo`/);
    assert.match(switcher, /id = 'mesa-runtime-switcher'/);
    assert.match(switcher, /Mesa operacional/);
    assert.match(switcher, /Internacional · BACBO_INT/);
    assert.match(switcher, /Brasil · BACBO_BR/);
    assert.match(switcher, /Execução financeira disponível nesta mesa/);
    assert.match(switcher, /Execução financeira bloqueada nesta mesa/);
});

test('MC25: BR bloqueia Trader na UI sem substituir o gate do backend', () => {
    assert.match(switcher, /mesa\?\.codigo === 'BACBO_BR'/);
    assert.match(switcher, /botao\.disabled = true/);
    assert.match(switcher, /botao\.removeAttribute\('onclick'\)/);
    assert.match(switcher, /botao\.textContent = '🔒 Trader'/);
    assert.match(switcher, /Execução financeira não autorizada para BACBO_BR/);
});

test('MC25: sair da INT avisa quando existe Auto-Trader ativo', () => {
    assert.match(switcher, /fetch\('\/api\/auto-traders'/);
    assert.match(switcher, /trader\.ativo === true \|\| trader\.ativo === 1/);
    assert.match(switcher, /atual\?\.codigo === 'BACBO_INT' && destino\.codigo === 'BACBO_BR'/);
    assert.match(switcher, /window\.confirm\(/);
    assert.match(switcher, /Trocar a visualização para a mesa BRASIL não interrompe o runtime INT/);
});
