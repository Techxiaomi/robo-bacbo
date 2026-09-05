'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot2_coletor.js'),
    'utf8'
);

function blocoEntre(inicioToken, fimToken) {
    const inicio = source.indexOf(inicioToken);
    assert.ok(inicio >= 0, `inicio ausente: ${inicioToken}`);

    const fim = source.indexOf(fimToken, inicio);
    assert.ok(fim > inicio, `fim ausente: ${fimToken}`);

    return source.slice(inicio, fim);
}

test('TIE-3B importa agregador puro e preserva classificador de captura', () => {
    assert.match(
        source,
        /const\s*\{\s*classificarTieObservado,\s*agregarLinhasTiePorPeriodo,\s*normalizarProtecaoSnapshot\s*\}\s*=\s*require\('\.\/tie_telemetry'\)/
    );
});

test('/api/estrategias lê somente escopo ESTRATEGIA', () => {
    const bloco = blocoEntre(
        'app.get("/api/estrategias"',
        'app.get("/api/dashboard-stats"'
    );

    assert.match(bloco, /FROM historico_tie_observado/);
    assert.match(bloco, /AND escopo='ESTRATEGIA'/);
    assert.doesNotMatch(bloco, /\bINSERT\b/i);
    assert.doesNotMatch(bloco, /\bUPDATE\b/i);
    assert.doesNotMatch(bloco, /\bDELETE\b/i);
    assert.doesNotMatch(bloco, /\bALTER\b/i);
});

test('/api/estrategias preserva legado e anexa tie_telemetry', () => {
    const bloco = blocoEntre(
        'app.get("/api/estrategias"',
        'app.get("/api/dashboard-stats"'
    );

    assert.match(bloco, /calcularDetalhesPadraoNoHistorico/);
    assert.match(bloco, /\.\.\.detalhesLegados\[periodo\]/);
    assert.match(bloco, /tie_telemetry:\s*telemetriaPorPeriodo\[periodo\]/);
});

test('/api/robos lê somente escopo ROBO', () => {
    const bloco = blocoEntre(
        'app.get("/api/robos"',
        'app.post("/api/robo"'
    );

    assert.match(bloco, /FROM historico_tie_observado/);
    assert.match(bloco, /AND escopo='ROBO'/);
    assert.doesNotMatch(bloco, /\bINSERT\b/i);
    assert.doesNotMatch(bloco, /\bUPDATE\b/i);
    assert.doesNotMatch(bloco, /\bDELETE\b/i);
    assert.doesNotMatch(bloco, /\bALTER\b/i);
});

test('/api/robos preserva ties legado e anexa tie_telemetry', () => {
    const bloco = blocoEntre(
        'app.get("/api/robos"',
        'app.post("/api/robo"'
    );

    assert.match(
        bloco,
        /ties:\s*\{\s*direto:\{\},\s*gale1:\{\},\s*gale2:\{\}\s*\}/
    );

    assert.match(bloco, /\.\.\.mapRobos\[r\.id\]\[periodo\]/);
    assert.match(bloco, /tie_telemetry:\s*telemetriaPorPeriodo\[periodo\]/);
    assert.match(bloco, /detalhes:\s*detalhesComTieTelemetry/);
});

test('dashboard-stats continua sem nova telemetria', () => {
    const bloco = blocoEntre(
        'app.get("/api/dashboard-stats"',
        'app.post("/api/simular-banca"'
    );

    assert.doesNotMatch(bloco, /historico_tie_observado/);
    assert.doesNotMatch(bloco, /tie_telemetry/);
});

test('simulador financeiro não recebe integração TIE-3B', () => {
    const inicio = source.indexOf('app.post("/api/simular-banca"');
    assert.ok(inicio >= 0);

    const trecho = source.slice(inicio, inicio + 9000);

    assert.doesNotMatch(trecho, /historico_tie_observado/);
    assert.doesNotMatch(trecho, /tie_telemetry/);
});
