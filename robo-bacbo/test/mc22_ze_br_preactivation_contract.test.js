'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mesaContext = require(
    '../mesa_context'
);

const financeiro = require(
    '../mesa_financial_scope'
);

const root = path.join(__dirname, '..');

function comMesaEnv(valor, executar) {
    const anterior =
        process.env.BACBO_MESA_CODIGO;

    try {
        process.env.BACBO_MESA_CODIGO =
            valor;

        return executar();
    } finally {
        if (anterior === undefined) {
            delete process.env
                .BACBO_MESA_CODIGO;
        } else {
            process.env.BACBO_MESA_CODIGO =
                anterior;
        }
    }
}

test('MC22-Z-E: BACBO_BR e identidade conhecida em pre-ativacao', () => {
    const br =
        mesaContext.resolverMesaConhecida(
            'bacbo_br'
        );

    assert.equal(
        br.codigo,
        'BACBO_BR'
    );

    assert.equal(
        br.tipo_jogo,
        'BACBO'
    );

    assert.equal(
        br.runtime_habilitado,
        false
    );

    assert.equal(
        br.ativo_persistido,
        false
    );
});

test('MC22-Z-E: selecionar BACBO_BR continua fail-closed no runtime', () => {
    comMesaEnv(
        'BACBO_BR',
        () => {
            assert.throws(
                () => mesaContext.mesaConfigurada(),
                erro => (
                    erro
                    && erro.code
                        === 'MESA_RUNTIME_NAO_HABILITADA'
                )
            );
        }
    );
});

test('MC22-Z-E: BACBO_INT continua sendo unico runtime habilitado', () => {
    assert.equal(
        mesaContext.MESAS_CONHECIDAS
            .BACBO_INT
            .runtime_habilitado,
        true
    );

    assert.equal(
        mesaContext.MESAS_CONHECIDAS
            .BACBO_BR
            .runtime_habilitado,
        false
    );

    assert.equal(
        mesaContext.mesaPadrao().codigo,
        'BACBO_INT'
    );
});

test('MC22-Z-E: schema cadastra catalogo e for?a pre-ativacao inativa', () => {
    const source = fs.readFileSync(
        path.join(root, 'mesa_schema.js'),
        'utf8'
    );

    assert.match(
        source,
        /Object\.values\(MESAS_CONHECIDAS\)/
    );

    assert.match(
        source,
        /ativo_persistido === true/
    );

    assert.match(
        source,
        /runtime_habilitado !== true/
    );

    assert.match(
        source,
        /SET ativo=false/
    );
});

test('MC22-Z-E: cadastro BR nao concede autorizacao financeira', () => {
    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            'BACBO_BR'
        ),
        false
    );

    const erro =
        financeiro.criarErroMesaFinanceira(
            'BACBO_BR',
            'place_bet'
        );

    assert.equal(
        erro.code,
        'MESA_FINANCEIRA_NAO_AUTORIZADA'
    );
});
