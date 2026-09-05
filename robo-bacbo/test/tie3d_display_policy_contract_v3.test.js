'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const robos = fs.readFileSync(path.join(ROOT, 'public', 'ui-enhancements.js'), 'utf8');
const padroes = fs.readFileSync(path.join(ROOT, 'public', 'dom-ui2-transform.js'), 'utf8');

test('TIE-3D: robôs protegidos preservam ties legado e multiplicadores', () => {
    assert.match(robos, /Object\.entries\(s\.ties\?\.\[nivel\] \|\| \{\}\)/);
    assert.match(robos, /escapar\(multiplicador\)/);
    assert.match(robos, /resumo\.htmlTies/);
});

test('TIE-3D: robôs sem proteção mostram factual por DIRETO GALE1 GALE2', () => {
    assert.match(robos, /Empates sem proteção:/);
    assert.match(robos, /semProtecaoNivel/);
    assert.match(robos, /DIRETO:/);
    assert.match(robos, /GALE1:/);
    assert.match(robos, /GALE2:/);
});

test('TIE-3D: padrões protegidos usam legado; sem proteção usa telemetria factual', () => {
    assert.match(padroes, /est\.proteger_empate \?/);
    assert.match(padroes, /Object\.entries\(s\.ties\?\.\[nivel\] \|\| \{\}\)/);
    assert.match(padroes, /\$\{multiplicador\}/);
    assert.match(padroes, /telemetria\?\.sem_protecao\?\.direto/);
    assert.match(padroes, /telemetria\?\.sem_protecao\?\.gale1/);
    assert.match(padroes, /telemetria\?\.sem_protecao\?\.gale2/);
});

test('TIE-3D mantém Hoje como default e ordem dos períodos', () => {
    assert.match(robos, /const PERIODOS_ROBO = \['hoje', '24h', 'semana', 'mes', 'geral'\]/);
    assert.match(robos, /let roboPeriodoAtual = 'hoje';/);
    assert.match(padroes, /const periodos = \['hoje', '24h', 'semana', 'mes', 'geral'\]/);
});

test('TIE-3D UI não introduz chamada de runtime financeiro', () => {
    for (const src of [robos, padroes]) {
        assert.doesNotMatch(src, /place_bet|EXECUTOR_URL|redis_runtime_v3|automatic_financial_dispatch|auditoria_ordens/);
    }
});
