'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const financeiro = require(
    '../mesa_financial_scope'
);

const root = path.join(__dirname, '..');

const bot2Source = fs.readFileSync(
    path.join(root, 'bot2_coletor.js'),
    'utf8'
);

test('MC22-Z-D: mesa financeira autorizada continua somente BACBO_INT', () => {
    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            'BACBO_INT'
        ),
        true
    );

    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            '  bacbo_int  '
        ),
        true
    );
});

test('MC22-Z-D: identidade nao padrao e recusada financeiramente', () => {
    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            'MESA_TESTE_2'
        ),
        false
    );

    const erro =
        financeiro.criarErroMesaFinanceira(
            'MESA_TESTE_2',
            'place_bet'
        );

    assert.equal(
        erro.code,
        'MESA_FINANCEIRA_NAO_AUTORIZADA'
    );
});

test('MC22-Z-D: sync de saldo e barrado antes de tocar Redis', () => {
    const inicio = bot2Source.indexOf(
        'async function solicitarSincronizacaoSaldoRedis()'
    );

    assert.notEqual(inicio, -1);

    const trecho = bot2Source.slice(
        inicio,
        inicio + 700
    );

    const guard = trecho.indexOf(
        "afirmarMesaFinanceiraAutorizada("
    );

    const redis = trecho.indexOf(
        'garantirRedisSaldoPronto()'
    );

    assert.ok(guard >= 0);
    assert.ok(redis >= 0);
    assert.ok(guard < redis);
});

test('MC22-Z-D: place_bet e barrado antes de criar espera financeira', () => {
    const inicio = bot2Source.indexOf(
        'async function enviarOrdemAoExecutor('
    );

    assert.notEqual(inicio, -1);

    const trecho = bot2Source.slice(
        inicio,
        inicio + 800
    );

    const guard = trecho.indexOf(
        "afirmarMesaFinanceiraAutorizada("
    );

    const espera = trecho.indexOf(
        'criarEsperaResultadoExecutor(orderId)'
    );

    assert.ok(guard >= 0);
    assert.ok(espera >= 0);
    assert.ok(guard < espera);
});

test('MC22-Z-D: ativacao financeira e barrada antes de consultar cache de saldo', () => {
    const inicio = bot2Source.indexOf(
        'async function obterSaldoAutoTraderParaAtivacao()'
    );

    assert.notEqual(inicio, -1);

    const trecho = bot2Source.slice(
        inicio,
        inicio + 1200
    );

    const guard = trecho.indexOf(
        'afirmarMesaFinanceiraAutorizada('
    );

    const cache = trecho.indexOf(
        'obterSaldoGlobalFresco()'
    );

    assert.ok(guard >= 0);
    assert.ok(cache >= 0);
    assert.ok(guard < cache);
});

test('MC22-Z-D: atualizacoes de saldo persistem somente na mesa runtime', () => {
    const globais = (
        bot2Source.match(
            /UPDATE auto_traders SET saldo_atual=\? WHERE ativo=true['"]/g
        ) || []
    );

    assert.equal(
        globais.length,
        0
    );

    const escopadas = (
        bot2Source.match(
            /UPDATE auto_traders SET saldo_atual=\? WHERE ativo=true AND mesa_id=\?/g
        ) || []
    );

    assert.equal(
        escopadas.length,
        2
    );
});

test('MC22-Z-D: segunda mesa continua nao cadastrada e canais financeiros seguem globais', () => {
    const mesaContext = fs.readFileSync(
        path.join(root, 'mesa_context.js'),
        'utf8'
    );

    const codigoSegundaMesa =
        ['BACBO', 'BR'].join('_');

    assert.equal(
        mesaContext.includes(
            codigoSegundaMesa
        ),
        false
    );

    const executor = fs.readFileSync(
        path.join(
            root,
            '..',
            'robo-sync-pilot',
            'robo.py'
        ),
        'utf8'
    );

    assert.match(
        executor,
        /REDIS_COMMAND_CHANNEL\s*=\s*["']auto_trader_commands["']/
    );

    assert.match(
        executor,
        /REDIS_RESPONSE_CHANNEL\s*=\s*["']auto_trader_responses["']/
    );
});
