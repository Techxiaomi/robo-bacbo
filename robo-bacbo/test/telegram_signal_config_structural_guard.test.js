'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validarMigracaoConfigTelegram
} = require('../telegram_signal_config');

function estadoG2() {
    return {
        origens: [
            {
                id: 1,
                mesa_id: 1,
                nome: 'A'
            }
        ],

        estrategias: [
            {
                id: 'e1',
                mesa_id: 1,
                nome: 'E1',
                origem: 'A',
                gales: 2,
                proteger_empate: false,
                ativo: true,
                is_dinamico: false,
                robo_dono_id: null
            }
        ]
    };
}

test(
    'telegram migration preserva config estrutural valido',
    () => {
        const result =
            validarMigracaoConfigTelegram({
                row: {
                    id: 10,
                    mesa_id: 1,

                    config_json:
                        JSON.stringify({
                            origens: ['A'],
                            avulsos: [],
                            excecoes: [],

                            mostrar_nome:
                                false
                        })
                },

                estado:
                    estadoG2()
            });

        assert.equal(
            result.ok,
            true
        );

        assert.equal(
            result.alterado,
            true
        );

        assert.deepEqual(
            result.config.origens,
            ['A']
        );

        assert.deepEqual(
            result.config.avulsos,
            []
        );

        assert.deepEqual(
            result.config.excecoes,
            []
        );
    }
);

test(
    'telegram migration falha fechada para JSON invalido',
    () => {
        const result =
            validarMigracaoConfigTelegram({
                row: {
                    id: 10,
                    mesa_id: 1,
                    config_json:
                        '{invalido'
                },

                estado:
                    estadoG2()
            });

        assert.equal(
            result.ok,
            false
        );

        assert.equal(
            result.status,
            409
        );

        assert.equal(
            result.body.erro,
            'TELEGRAM_CONFIG_ESTRUTURAL_INDETERMINADA'
        );

        assert.equal(
            result.body.motivo,
            'CONFIG_JSON_INVALIDO'
        );
    }
);

test(
    'telegram migration usa SSOT e bloqueia referencia inexistente',
    () => {
        const result =
            validarMigracaoConfigTelegram({
                row: {
                    id: 10,
                    mesa_id: 1,

                    config_json:
                        JSON.stringify({
                            origens: [
                                'ORIGEM_INEXISTENTE'
                            ],

                            avulsos: [],
                            excecoes: [],
                            mostrar_nome:
                                false
                        })
                },

                estado:
                    estadoG2()
            });

        assert.equal(
            result.ok,
            false
        );

        assert.equal(
            result.status,
            409
        );

        assert.equal(
            result.body.erro,
            'ROBO_REFERENCIAS_INVALIDAS'
        );
    }
);

test(
    'telegram migration sem mudanca visual nao exige write',
    () => {
        const result =
            validarMigracaoConfigTelegram({
                row: {
                    id: 10,
                    mesa_id: 1,

                    config_json:
                        JSON.stringify({
                            origens: ['A'],
                            avulsos: [],
                            excecoes: [],

                            telegram_nome_robo:
                                true,

                            telegram_nome_estrategia:
                                true,

                            telegram_padrao:
                                true,

                            telegram_assertividade_geral:
                                true,

                            telegram_assertividade_24h:
                                false,

                            telegram_detalhar_empates:
                                true,

                            mostrar_nome:
                                true,

                            mostrar_padrao:
                                true,

                            mostrar_assertividade:
                                true,

                            detalhar_empates:
                                true
                        })
                },

                estado:
                    estadoG2()
            });

        assert.equal(
            result.ok,
            true
        );

        assert.equal(
            result.alterado,
            false
        );
    }
);
