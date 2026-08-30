'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const bot2Source = fs.readFileSync(
    path.join(root, 'bot2_coletor.js'),
    'utf8'
);

const migrationSource = fs.readFileSync(
    path.join(root, 'mesa_scope_migration.js'),
    'utf8'
);

test('MC22-Z-B: fresh install cria mesa_id NOT NULL sem DEFAULT de runtime', () => {
    const neutros = (
        bot2Source.match(
            /mesa_id SMALLINT UNSIGNED NOT NULL,/g
        ) || []
    );

    assert.equal(
        neutros.length,
        8
    );

    assert.doesNotMatch(
        bot2Source,
        /mesa_id SMALLINT UNSIGNED NOT NULL DEFAULT/
    );

    assert.doesNotMatch(
        bot2Source,
        /DEFAULT\s+\$\{mesaIdSchema\}/
    );
});

test('MC22-Z-B: migration nao persiste DEFAULT dependente da mesa atual', () => {
    assert.doesNotMatch(
        migrationSource,
        /DEFAULT\s+\$\{mesaId\}/
    );

    assert.match(
        migrationSource,
        /ADD COLUMN mesa_id SMALLINT UNSIGNED NULL/
    );

    assert.match(
        migrationSource,
        /MODIFY COLUMN mesa_id\s+SMALLINT UNSIGNED NOT NULL/
    );
});

test('MC22-Z-B: backfill legado altera somente linhas sem mesa', () => {
    assert.match(
        migrationSource,
        /SET mesa_id=\?\s+WHERE mesa_id IS NULL/
    );

    assert.doesNotMatch(
        migrationSource,
        /SET mesa_id=\?(?![\s\S]{0,80}WHERE mesa_id IS NULL)/
    );
});

test('MC22-Z-B: migration valida ausencia final de DEFAULT', () => {
    assert.match(
        migrationSource,
        /const finalDefaultPresente/
    );

    assert.match(
        migrationSource,
        /MESA_SCHEMA_NAO_NEUTRO/
    );

    assert.match(
        migrationSource,
        /finalDefaultPresente[\s\S]{0,160}finalTipoOk/
    );
});

test('MC22-Z-B: caminhos financeiros continuam escrevendo mesa_id explicitamente', () => {
    assert.match(
        bot2Source,
        /INSERT INTO auditoria_ordens[\s\S]{0,180}\(mesa_id,\s*trader_id/
    );

    assert.match(
        bot2Source,
        /INSERT INTO auto_traders[\s\S]{0,180}\(mesa_id,\s*nome/
    );

    assert.match(
        bot2Source,
        /INSERT INTO historico_resultados[\s\S]{0,180}\(mesa_id,\s*estrategia_id/
    );
});
