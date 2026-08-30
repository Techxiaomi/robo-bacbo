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

const ROUND_VALIDO_BR =
    '11111111-1111-4111-8111-111111111111';

function comEnv(
    valores,
    executar
) {
    const chaves = [
        'BACBO_MESA_CODIGO',
        'BACBO_MESA_RUNTIME_ENABLED',
        'TIPMINER_BACBO_ROUND_ID'
    ];

    const anteriores =
        Object.fromEntries(
            chaves.map(
                chave => [
                    chave,
                    process.env[chave]
                ]
            )
        );

    try {
        for (
            const chave of chaves
        ) {
            if (
                Object.prototype
                    .hasOwnProperty
                    .call(valores, chave)
            ) {
                const valor =
                    valores[chave];

                if (
                    valor === undefined
                ) {
                    delete process.env[chave];
                } else {
                    process.env[chave] =
                        valor;
                }
            } else {
                delete process.env[chave];
            }
        }

        return executar();
    } finally {
        for (
            const chave of chaves
        ) {
            const anterior =
                anteriores[chave];

            if (
                anterior === undefined
            ) {
                delete process.env[chave];
            } else {
                process.env[chave] =
                    anterior;
            }
        }
    }
}

test('MC22-Z-F: BACBO_INT continua dispensando opt-in de runtime', () => {
    const int =
        mesaContext.resolverMesaConhecida(
            'BACBO_INT'
        );

    assert.equal(
        mesaContext
            .afirmarMesaRuntimeHabilitada(
                int,
                {}
            )
            .codigo,
        'BACBO_INT'
    );
});

test('MC22-Z-F: BACBO_BR sem opt-in continua fail-closed', () => {
    const br =
        mesaContext.resolverMesaConhecida(
            'BACBO_BR'
        );

    assert.throws(
        () =>
            mesaContext
                .afirmarMesaRuntimeHabilitada(
                    br,
                    {}
                ),
        erro => (
            erro
            && erro.code
                === 'MESA_RUNTIME_ATIVACAO_EXPLICITA_AUSENTE'
        )
    );
});

test('MC22-Z-F: opt-in BR sem round TipMiner falha fechado', () => {
    const br =
        mesaContext.resolverMesaConhecida(
            'BACBO_BR'
        );

    assert.throws(
        () =>
            mesaContext
                .afirmarMesaRuntimeHabilitada(
                    br,
                    {
                        BACBO_MESA_RUNTIME_ENABLED:
                            '1'
                    }
                ),
        erro => (
            erro
            && erro.code
                === 'MESA_RUNTIME_FONTE_AUSENTE'
        )
    );
});

test('MC22-Z-F: round BR precisa ter formato UUID', () => {
    const br =
        mesaContext.resolverMesaConhecida(
            'BACBO_BR'
        );

    assert.throws(
        () =>
            mesaContext
                .afirmarMesaRuntimeHabilitada(
                    br,
                    {
                        BACBO_MESA_RUNTIME_ENABLED:
                            '1',
                        TIPMINER_BACBO_ROUND_ID:
                            'round-invalido'
                    }
                ),
        erro => (
            erro
            && erro.code
                === 'MESA_RUNTIME_FONTE_INVALIDA'
        )
    );
});

test('MC22-Z-F: BR nao pode reutilizar round conhecido da INT', () => {
    const br =
        mesaContext.resolverMesaConhecida(
            'BACBO_BR'
        );

    assert.throws(
        () =>
            mesaContext
                .afirmarMesaRuntimeHabilitada(
                    br,
                    {
                        BACBO_MESA_RUNTIME_ENABLED:
                            '1',
                        TIPMINER_BACBO_ROUND_ID:
                            mesaContext
                                .TIPMINER_ROUND_ID_INT_CONHECIDO
                    }
                ),
        erro => (
            erro
            && erro.code
                === 'MESA_RUNTIME_FONTE_CRUZADA'
        )
    );
});

test('MC22-Z-F: BR com opt-in e round proprio passa apenas pelo gate de codigo', () => {
    comEnv(
        {
            BACBO_MESA_CODIGO:
                'BACBO_BR',
            BACBO_MESA_RUNTIME_ENABLED:
                '1',
            TIPMINER_BACBO_ROUND_ID:
                ROUND_VALIDO_BR
        },
        () => {
            const mesa =
                mesaContext
                    .mesaConfigurada();

            assert.equal(
                mesa.codigo,
                'BACBO_BR'
            );

            assert.equal(
                mesa.runtime_habilitado,
                false
            );

            assert.equal(
                mesa.runtime_ativacao_explicita,
                true
            );
        }
    );
});

test('MC22-Z-F: schema exige ativo persistido e nao reseta mesa explicitamente ativavel', () => {
    const source = fs.readFileSync(
        path.join(
            root,
            'mesa_schema.js'
        ),
        'utf8'
    );

    assert.match(
        source,
        /MESA_PERSISTIDA_INATIVA/
    );

    assert.match(
        source,
        /conhecida\.runtime_habilitado !== true\s*&&\s*conhecida\.runtime_ativacao_explicita !== true/
    );
});

test('MC22-Z-F: liberar runtime BR nao libera financeiro', () => {
    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            'BACBO_BR'
        ),
        false
    );

    assert.equal(
        financeiro.mesaFinanceiraPermitida(
            'BACBO_INT'
        ),
        true
    );
});
