'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const escopo = require(
    '../mesa_operational_scope'
);

const logger = require('../logger');
const metrics = require('../metrics');
const operations = require(
    '../operations_metrics'
);

const root = path.join(__dirname, '..');

test('MC22-Z-C: BACBO_INT preserva nomes operacionais legados', () => {
    const env = {};

    assert.equal(
        escopo.codigoMesaOperacional(env),
        'BACBO_INT'
    );

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.jsonl',
            env
        ),
        'backend.jsonl'
    );

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.metrics.json',
            env
        ),
        'backend.metrics.json'
    );

    assert.equal(
        escopo.nomeCookieEscopadoPorMesa(
            'bacbo_admin_session',
            env
        ),
        'bacbo_admin_session'
    );
});

test('MC22-Z-C: segunda identidade recebe sufixo operacional isolado', () => {
    const env = {
        BACBO_MESA_CODIGO: '  mesa_teste_2  '
    };

    assert.equal(
        escopo.codigoMesaOperacional(env),
        'MESA_TESTE_2'
    );

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.jsonl',
            env
        ),
        'backend.MESA_TESTE_2.jsonl'
    );

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.metrics.json',
            env
        ),
        'backend.metrics.MESA_TESTE_2.json'
    );

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.operations.json',
            env
        ),
        'backend.operations.MESA_TESTE_2.json'
    );

    assert.equal(
        escopo.nomeCookieEscopadoPorMesa(
            'bacbo_admin_session',
            env
        ),
        'bacbo_admin_session_MESA_TESTE_2'
    );
});

test('MC22-Z-C: escopo de arquivo e cookie e idempotente e fail-closed', () => {
    const env = {
        BACBO_MESA_CODIGO: 'MESA_TESTE_2'
    };

    assert.equal(
        escopo.nomeArquivoEscopadoPorMesa(
            'backend.MESA_TESTE_2.jsonl',
            env
        ),
        'backend.MESA_TESTE_2.jsonl'
    );

    assert.equal(
        escopo.nomeCookieEscopadoPorMesa(
            'bacbo_admin_session_MESA_TESTE_2',
            env
        ),
        'bacbo_admin_session_MESA_TESTE_2'
    );

    assert.throws(
        () => escopo.codigoMesaOperacional({
            BACBO_MESA_CODIGO: 'mesa invalida'
        }),
        erro => (
            erro
            && erro.code
                === 'MESA_OPERACIONAL_CODIGO_INVALIDO'
        )
    );
});

test('MC22-Z-C: todos os sinks locais usam o mesmo escopo de mesa', () => {
    const env = {
        BACBO_MESA_CODIGO: 'MESA_TESTE_2'
    };

    const logConfig = logger.configLogging({
        env,
        baseDir: root
    });

    const metricsConfig =
        metrics.configMetricas({
            env,
            baseDir: root
        });

    const operationsConfig =
        operations.configMetricasOperacionais({
            env,
            baseDir: root
        });

    assert.equal(
        path.basename(logConfig.filePath),
        'backend.MESA_TESTE_2.jsonl'
    );

    assert.equal(
        path.basename(metricsConfig.filePath),
        'backend.metrics.MESA_TESTE_2.json'
    );

    assert.equal(
        path.basename(
            operationsConfig.filePath
        ),
        'backend.operations.MESA_TESTE_2.json'
    );
});

test('MC22-Z-C: sessao administrativa usa cookie escopado pela mesa', () => {
    const source = fs.readFileSync(
        path.join(root, 'bot2_coletor.js'),
        'utf8'
    );

    assert.match(
        source,
        /nomeCookieEscopadoPorMesa/
    );

    assert.match(
        source,
        /const ADMIN_SESSION_COOKIE\s*=\s*nomeCookieEscopadoPorMesa/
    );

    assert.doesNotMatch(
        source,
        /const ADMIN_SESSION_COOKIE\s*=\s*['"]bacbo_admin_session['"]/
    );
});

test('MC22-Z-C: identidade BR conhecida preserva Redis financeiro global', () => {
    const mesaContext = fs.readFileSync(
        path.join(root, 'mesa_context.js'),
        'utf8'
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

    const codigoSegundaMesa =
        ['BACBO', 'BR'].join('_');

    assert.equal(
        mesaContext.includes(
            codigoSegundaMesa
        ),
        true
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
