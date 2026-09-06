'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Hoje é default da UI em dashboard, padrões e robôs', () => {
    const dash = read('public/dashboard-ui.js');
    const html = read('public/dashboard-app.html');
    const robos = read('public/ui-enhancements.js');
    const padroes = read('public/dom-ui2-transform.js');

    assert.match(dash, /let dashboardPeriodoAtual = 'hoje';/);
    assert.match(dash, /\? periodo : 'hoje';/);
    assert.match(html, /let dashPeriodoAtual = 'hoje'; let padroesPeriodoAtual = 'hoje';/);
    assert.match(robos, /let roboPeriodoAtual = 'hoje';/);
    assert.match(padroes, /const periodos = \['hoje', '24h', 'semana', 'mes', 'geral'\];/);
});

test('ordem de períodos é Hoje > 24H > Semana > Mês > Geral', () => {
    const dash = read('public/dashboard-ui.js');
    const html = read('public/dashboard-app.html');
    const robos = read('public/ui-enhancements.js');
    const padroes = read('public/dom-ui2-transform.js');

    assert.match(dash, /\['hoje', '24h', 'semana', 'mes', 'geral'\]/);
    assert.match(robos, /\['hoje', '24h', 'semana', 'mes', 'geral'\]/);
    assert.match(padroes, /\['hoje', '24h', 'semana', 'mes', 'geral'\]/);

    const ids = ['hoje', '24h', 'semana', 'mes', 'geral'];
    const pos = ids.map(id => html.indexOf(`id="btn-dash-${id}"`));
    assert.ok(pos.every(n => n >= 0));
    for (let i = 1; i < pos.length; i++) assert.ok(pos[i - 1] < pos[i]);
});

test('Hoje nasce visualmente ativo na barra do dashboard', () => {
    const html = read('public/dashboard-app.html');
    const hoje = html.match(/<button\s+id="btn-dash-hoje"[\s\S]*?<\/button>/)?.[0] || '';
    const h24 = html.match(/<button\s+id="btn-dash-24h"[\s\S]*?<\/button>/)?.[0] || '';

    assert.match(hoje, /background:\s*#007bff/i);
    assert.match(hoje, /color:\s*white/i);
    assert.match(h24, /background:\s*transparent/i);
    assert.match(h24, /color:\s*#888/i);
});

test('simulação/relatório abre em Hoje e preserva ordem lógica', () => {
    const html = read('public/dashboard-app.html');
    const bloco = html.match(/<select\s+id="sim-periodo">([\s\S]*?)<\/select>/)?.[1] || '';
    const esperado = ['hoje', '24h', 'semana', 'mes', 'geral'];
    const pos = esperado.map(id => bloco.indexOf(`value="${id}"`));

    assert.ok(pos.every(n => n >= 0));
    for (let i = 1; i < pos.length; i++) assert.ok(pos[i - 1] < pos[i]);
    assert.match(bloco, /<option\s+value="hoje"\s+selected>/);
});

