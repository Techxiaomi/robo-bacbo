'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot2_coletor.js'),
    'utf8'
);

test('cleanup de padrões IA órfãos remove telemetria TIE', () => {
    const inicio = source.indexOf(
        'const ids = orfaos.map(row => String(row.id));'
    );

    const fim = source.indexOf(
        'const [historicosOrfaos]',
        inicio
    );

    assert.ok(inicio >= 0);
    assert.ok(fim > inicio);

    const bloco = source.slice(inicio, fim);

    assert.match(
        bloco,
        /DELETE FROM historico_tie_observado[\s\S]*AND estrategia_id IN \(\$\{placeholders\}\)[\s\S]*\[mesaId, \.\.\.ids\]/
    );
});

test('exclusão individual remove telemetria TIE da estratégia', () => {
    const inicio = source.indexOf(
        'async function apagarEstrategiaEDados(id, mesaId)'
    );

    const fim = source.indexOf(
        'app.get("/api/origens"',
        inicio
    );

    const bloco = source.slice(inicio, fim);

    assert.match(
        bloco,
        /DELETE FROM historico_tie_observado WHERE estrategia_id=\? AND mesa_id=\?/
    );
});

test('exclusão de padrões IA atuais remove sua telemetria TIE', () => {
    const inicio = source.indexOf(
        'const idsPadroes = padroesIa.map(row => String(row.id));'
    );

    const fim = source.indexOf(
        'const prefixoHistoricoIa',
        inicio
    );

    const bloco = source.slice(inicio, fim);

    assert.match(
        bloco,
        /DELETE FROM historico_tie_observado[\s\S]*AND estrategia_id IN \(\$\{placeholders\}\)[\s\S]*\[mesaId, \.\.\.idsPadroes\]/
    );
});

test('exclusão definitiva do robô remove telemetria IA histórica pelo prefixo', () => {
    const inicio = source.indexOf(
        'const prefixoHistoricoIa = `ia_${roboId}_`;'
    );

    assert.ok(inicio >= 0);

    const bloco = source.slice(
        inicio,
        inicio + 2500
    );

    assert.match(
        bloco,
        /DELETE FROM historico_tie_observado[\s\S]*LEFT\(estrategia_id, \?\) = \?[\s\S]*prefixoHistoricoIa/
    );
});

test('exclusão definitiva remove telemetria do escopo ROBO', () => {
    const inicio = source.indexOf(
        '// Ao excluir o Robô/Canal, seu histórico de distribuição também deixa de ter proprietário.'
    );

    assert.ok(inicio >= 0);

    const bloco = source.slice(
        inicio,
        inicio + 1800
    );

    assert.match(
        bloco,
        /DELETE FROM historico_tie_observado[\s\S]*escopo='ROBO'[\s\S]*robo_id=\?/
    );
});

test('lifecycle preserva schema captura e histórico terminal', () => {
    assert.match(
        source,
        /CREATE TABLE IF NOT EXISTS historico_tie_observado/
    );

    assert.match(
        source,
        /INSERT INTO historico_tie_observado/
    );

    assert.match(
        source,
        /await registrarTieObservado\(\{/
    );

    assert.match(
        source,
        /if \(vencedor === est\.entrada \|\| \(isTie && est\.protegerEmpate\)\)/
    );

    assert.match(
        source,
        /if \(st\.galeAtual < est\.gales\)/
    );
});
