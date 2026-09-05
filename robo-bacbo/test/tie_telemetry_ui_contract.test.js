'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');

const bot = fs.readFileSync(
    path.join(repo, 'bot2_coletor.js'),
    'utf8'
);

const uiRobo = fs.readFileSync(
    path.join(repo, 'public', 'ui-enhancements.js'),
    'utf8'
);

const uiPadrao = fs.readFileSync(
    path.join(repo, 'public', 'dom-ui2-transform.js'),
    'utf8'
);

test('snapshot de proteção usa normalizador tri-state', () => {
    const inicio = bot.indexOf(
        'function snapshotProtecaoEmpateTelemetria('
    );

    const fim = bot.indexOf(
        'async function registrarTieObservado({',
        inicio
    );

    assert.ok(inicio >= 0);
    assert.ok(fim > inicio);

    const bloco = bot.slice(inicio, fim);

    assert.match(bloco, /normalizarProtecaoSnapshot/);
    assert.match(bloco, /est\?\.proteger_empate/);
    assert.doesNotMatch(
        bloco,
        /Number\s*\([^)]*proteger_empate[^)]*\)\s*===\s*0/
    );
});

test('persistência TIE não usa INSERT IGNORE e trata duplicidade explicitamente', () => {
    assert.doesNotMatch(
        bot,
        /INSERT IGNORE INTO historico_tie_observado/
    );

    assert.match(
        bot,
        /INSERT INTO historico_tie_observado/
    );

    assert.match(
        bot,
        /ON DUPLICATE KEY UPDATE id=id/
    );
});

test('card de robô usa tie_telemetry sem remover métricas legadas', () => {
    assert.match(uiRobo, /tie_telemetry/);
    assert.match(uiRobo, /Empates observados/);
    assert.match(uiRobo, /Protegidos:/);
    assert.match(uiRobo, /Sem proteção:/);
    assert.match(uiRobo, /Impacto financeiro:/);

    assert.match(
        uiRobo,
        /Object\.entries\(s\.ties\?\.\[nivel\] \|\| \{\}\)/
    );

    assert.match(
        uiRobo,
        /const greens = greensSemTie \+ ties/
    );
});

test('card de padrão usa tie_telemetry sem alterar resumo legado', () => {
    assert.match(uiPadrao, /tie_telemetry/);
    assert.match(uiPadrao, /Empates observados/);
    assert.match(uiPadrao, /Protegidos:/);
    assert.match(uiPadrao, /Sem proteção:/);
    assert.match(uiPadrao, /Impacto financeiro:/);

    assert.match(
        uiPadrao,
        /Object\.values\(s\.ties\?\.\[nivel\] \|\| \{\}\)/
    );

    assert.match(
        uiPadrao,
        /const greensTotal = greensSemTie \+ tiesNum/
    );
});

test('UI não inventa impacto monetário sem base', () => {
    for (const source of [uiRobo, uiPadrao]) {
        assert.match(
            source,
            /base monetária por evento não está registrada/
        );

        assert.match(
            source,
            /90% devolvido \/ 10% retido/
        );
    }
});

test('TIE-3C não adiciona chamadas de executor ou escrita financeira à UI', () => {
    for (const source of [uiRobo, uiPadrao]) {
        assert.doesNotMatch(source, /enviarOrdemAoExecutor/);
        assert.doesNotMatch(source, /place_bet/);
        assert.doesNotMatch(source, /auditoria_ordens/);
    }
});
