'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'bot2_coletor.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public', 'dashboard-app.html'), 'utf8');

test('robos_canais nasce em utf8mb4', () => {
    assert.match(
        backend,
        /CREATE TABLE IF NOT EXISTS robos_canais[\s\S]*?CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/
    );
});

test('bootstrap migra robos_canais legado somente quando necessário', () => {
    assert.match(
        backend,
        /SELECT TABLE_COLLATION[\s\S]*?TABLE_NAME = 'robos_canais'/
    );
    assert.match(
        backend,
        /if \(!collationRobos\.startsWith\('utf8mb4_'\)\)[\s\S]*?ALTER TABLE robos_canais[\s\S]*?CONVERT TO CHARACTER SET utf8mb4[\s\S]*?COLLATE utf8mb4_unicode_ci/
    );
});

test('POST /api/robo devolve erro interno estruturado', () => {
    assert.match(backend, /erro: 'ROBO_SALVAR_FALHA_INTERNA'/);
    assert.match(
        backend,
        /mensagem: String\(e\?\.message \|\| 'Falha interna ao salvar o robô\.'\)/
    );
});

test('UI mostra mensagem real da API ao salvar robô', () => {
    assert.match(ui, /const erroApi = await res\.json\(\)/);
    assert.match(ui, /erroApi\?\.mensagem[\s\S]*?erroApi\?\.erro/);
    assert.match(ui, /Erro ao salvar o robô: \$\{detalhe\}/);
});
