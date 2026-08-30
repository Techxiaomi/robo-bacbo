'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mesaContext = require('../mesa_context');

const root = path.join(__dirname, '..');

function comMesaEnv(valor, executar) {
    const anterior = process.env.BACBO_MESA_CODIGO;

    try {
        if (valor === undefined) {
            delete process.env.BACBO_MESA_CODIGO;
        } else {
            process.env.BACBO_MESA_CODIGO = valor;
        }

        return executar();
    } finally {
        if (anterior === undefined) {
            delete process.env.BACBO_MESA_CODIGO;
        } else {
            process.env.BACBO_MESA_CODIGO = anterior;
        }
    }
}

test('MC22-Z-A: ausencia de configuracao preserva BACBO_INT', () => {
    comMesaEnv(undefined, () => {
        assert.equal(
            mesaContext.codigoMesaConfigurada(),
            'BACBO_INT'
        );

        assert.equal(
            mesaContext.mesaConfigurada().codigo,
            'BACBO_INT'
        );
    });
});

test('MC22-Z-A: codigo configurado e normalizado antes da resolucao', () => {
    comMesaEnv('  bacbo_int  ', () => {
        assert.equal(
            mesaContext.codigoMesaConfigurada(),
            'BACBO_INT'
        );

        assert.equal(
            mesaContext.mesaConfigurada().codigo,
            'BACBO_INT'
        );
    });
});

test('MC22-Z-A: mesa nao cadastrada continua fail-closed', () => {
    comMesaEnv('MESA_TESTE_2', () => {
        assert.throws(
            () => mesaContext.mesaConfigurada(),
            erro => (
                erro
                && erro.code === 'MESA_NAO_SUPORTADA'
            )
        );
    });
});

test('MC22-Z-A: catalogo continua contendo somente a mesa internacional', () => {
    assert.deepEqual(
        Object.keys(
            mesaContext.MESAS_CONHECIDAS
        ),
        ['BACBO_INT']
    );
});

test('MC22-Z-A: schema e transporte dependem do seletor configurado', () => {
    const schemaSource = fs.readFileSync(
        path.join(root, 'mesa_schema.js'),
        'utf8'
    );

    const transportSource = fs.readFileSync(
        path.join(
            root,
            'mesa_transport_context.js'
        ),
        'utf8'
    );

    assert.match(
        schemaSource,
        /mesaConfigurada/
    );

    assert.doesNotMatch(
        schemaSource,
        /mesaPadrao/
    );

    assert.match(
        transportSource,
        /mesaConfigurada/
    );

    assert.doesNotMatch(
        transportSource,
        /mesaPadrao/
    );
});
