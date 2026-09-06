'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'bot2_coletor.js'
    ),
    'utf8'
);

function blocoEntre(inicio, fim) {
    const a = backend.indexOf(inicio);
    const b = backend.indexOf(fim, a + 1);

    assert.ok(
        a >= 0,
        `início ausente: ${inicio}`
    );

    assert.ok(
        b > a,
        `fim ausente: ${fim}`
    );

    return backend.slice(a, b);
}

test('backend importa route support uma única vez', () => {
    assert.equal(
        (
            backend.match(
                /strategy_profile_route_support/g
            )
            || []
        ).length,
        1
    );
});

test('POST novo-padrao valida antes de INSERT', () => {
    const bloco = blocoEntre(
        'app.post("/api/novo-padrao"',
        'app.put("/api/estrategia/:id"'
    );

    const validar =
        bloco.indexOf(
            'await validarCriacaoEstrategiaRoute({'
        );

    const inserir =
        bloco.indexOf(
            'INSERT INTO estrategias'
        );

    assert.ok(validar >= 0);
    assert.ok(inserir > validar);

    assert.match(
        bloco,
        /\.status\(validacaoEstrutural\.status\)[\s\S]*?\.json\(validacaoEstrutural\.body\)/
    );
});

test('PUT estrategia valida antes de UPDATE', () => {
    const bloco = blocoEntre(
        'app.put("/api/estrategia/:id"',
        'app.delete("/api/estrategia/:id"'
    );

    const validar =
        bloco.indexOf(
            'await validarEdicaoEstrategiaRoute({'
        );

    const atualizar =
        bloco.indexOf(
            'UPDATE estrategias SET'
        );

    assert.ok(validar >= 0);
    assert.ok(atualizar > validar);
});

test('POST robo valida antes de INSERT', () => {
    const bloco = blocoEntre(
        'app.post("/api/robo"',
        'app.put("/api/robo/:id"'
    );

    const validar =
        bloco.indexOf(
            'await validarCriacaoRoboRoute({'
        );

    const inserir =
        bloco.indexOf(
            'INSERT INTO robos_canais'
        );

    assert.ok(validar >= 0);
    assert.ok(inserir > validar);
});

test('PUT robo preserva 404 antes do novo gate', () => {
    const bloco = blocoEntre(
        'app.put("/api/robo/:id"',
        'app.post("/api/robo/:id/testar-telegram"'
    );

    const pos404 =
        bloco.indexOf(
            'robo_nao_encontrado'
        );

    const posGate =
        bloco.indexOf(
            'await validarEdicaoRoboRoute({'
        );

    assert.ok(pos404 >= 0);
    assert.ok(posGate > pos404);
});

test('as quatro incompatibilidades retornam status/body do domínio', () => {
    const ocorrenciasStatus =
        backend.match(
            /\.status\(validacaoEstrutural\.status\)/g
        )
        || [];

    const ocorrenciasBody =
        backend.match(
            /\.json\(validacaoEstrutural\.body\)/g
        )
        || [];

    assert.equal(
        ocorrenciasStatus.length,
        4
    );

    assert.equal(
        ocorrenciasBody.length,
        4
    );
});
