'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');

function extrairFuncao(fonte, nome, proximoMarcador) {
    const inicio = fonte.indexOf(`async function ${nome}(`);
    assert.notEqual(inicio, -1, `${nome} deve existir no backend`);
    const fim = fonte.indexOf(proximoMarcador, inicio);
    assert.notEqual(fim, -1, `marcador final de ${nome} deve existir`);
    return fonte.slice(inicio, fim);
}

test('padrão IA calcula assertividade pela janela bruta do robô proprietário', () => {
    const fonte = fs.readFileSync(backendPath, 'utf8');
    const bloco = extrairFuncao(
        fonte,
        'calcularAssertividadePersistidaEstrategia',
        '\nfunction roboSintonizaEstrategia'
    );

    assert.match(bloco, /if \(est && est\.is_dinamico\)/);
    assert.match(bloco, /ROBOS_MEMORIA\.find/);
    assert.match(bloco, /auto_tuning\?\.range/);
    assert.match(bloco, /historicoGirosAnalitico\.slice\(-rangeDinamico\)/);
    assert.match(bloco, /calcularDetalhesPadraoNoHistorico\s*\(/);
    assert.match(bloco, /dadosDinamicos/);
    assert.match(bloco, /Date\.now\(\)/);
    assert.match(bloco, /\)\.geral/);
    assert.match(bloco, /contarTiesLegados\(detalhes\.ties\)/);
});

test('padrões manuais preservam caminho histórico persistido', () => {
    const fonte = fs.readFileSync(backendPath, 'utf8');
    const bloco = extrairFuncao(
        fonte,
        'calcularAssertividadePersistidaEstrategia',
        '\nfunction roboSintonizaEstrategia'
    );

    assert.match(bloco, /SELECT green_direto, gale1, gale2, red, ties_json FROM estrategias/);
    assert.match(bloco, /FROM historico_resultados/);
    assert.match(bloco, /GROUP BY tipo_resultado/);
});
