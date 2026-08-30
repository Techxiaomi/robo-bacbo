'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root =
    path.join(__dirname, '..');

const migrationSource =
    fs.readFileSync(
        path.join(
            root,
            'mesa_scope_migration.js'
        ),
        'utf8'
    );

const botSource =
    fs.readFileSync(
        path.join(
            root,
            'bot2_coletor.js'
        ),
        'utf8'
    );

function blocoRotasOrigens() {
    const inicio =
        botSource.indexOf(
            'app.get("/api/origens"'
        );

    const fim =
        botSource.indexOf(
            'app.get("/api/robos"',
            inicio
        );

    assert.ok(
        inicio >= 0,
        'inicio das rotas de origens ausente'
    );

    assert.ok(
        fim > inicio,
        'fim das rotas de origens ausente'
    );

    return botSource.slice(
        inicio,
        fim
    );
}

test(
    'MC23-B: fresh schema cria origens com mesa_id obrigatorio',
    () => {
        assert.match(
            botSource,
            /CREATE TABLE IF NOT EXISTS origens\s*\([\s\S]*?mesa_id SMALLINT UNSIGNED NOT NULL[\s\S]*?nome VARCHAR\(100\)/
        );
    }
);

test(
    'MC23-B: backfill legado de origens pertence sempre a BACBO_INT',
    () => {
        assert.match(
            migrationSource,
            /MESA_PADRAO_CODIGO/
        );

        assert.match(
            migrationSource,
            /TABELAS_ORIGENS_MC23B/
        );

        assert.match(
            migrationSource,
            /SELECT id[\s\S]*?FROM mesas[\s\S]*?WHERE codigo=\?[\s\S]*?LIMIT 1/
        );

        assert.match(
            migrationSource,
            /mesaIdLegadoOrigens[\s\S]*?MESA_PADRAO_CODIGO/
        );

        assert.match(
            migrationSource,
            /garantirMesaIdTabela\([\s\S]*?mesaIdLegadoOrigens[\s\S]*?'MC23-B'/
        );
    }
);

test(
    'MC23-B: leitura e criacao de origens usam mesa runtime',
    () => {
        const bloco =
            blocoRotasOrigens();

        assert.match(
            bloco,
            /FROM origens[\s\S]*?WHERE mesa_id=\?[\s\S]*?ORDER BY nome ASC/
        );

        assert.match(
            bloco,
            /INSERT INTO origens[\s\S]*?\(mesa_id, nome\)[\s\S]*?VALUES \(\?, \?\)/
        );

        assert.doesNotMatch(
            bloco,
            /SELECT \* FROM origens ORDER BY nome ASC/
        );

        assert.doesNotMatch(
            bloco,
            /INSERT INTO origens \(nome\) VALUES/
        );
    }
);

test(
    'MC23-B: rename e delete nao atravessam mesas',
    () => {
        const bloco =
            blocoRotasOrigens();

        assert.match(
            bloco,
            /FROM origens[\s\S]*?WHERE id=\?[\s\S]*?AND mesa_id=\?[\s\S]*?FOR UPDATE/
        );

        assert.match(
            bloco,
            /UPDATE origens[\s\S]*?WHERE id=\?[\s\S]*?AND mesa_id=\?/
        );

        assert.match(
            bloco,
            /UPDATE estrategias[\s\S]*?WHERE origem=\?[\s\S]*?AND is_dinamico=false[\s\S]*?AND mesa_id=\?/
        );

        assert.match(
            bloco,
            /DELETE FROM origens[\s\S]*?WHERE id=\?[\s\S]*?AND mesa_id=\?/
        );

        assert.doesNotMatch(
            bloco,
            /req\.body\.nomeAntigo/
        );
    }
);
