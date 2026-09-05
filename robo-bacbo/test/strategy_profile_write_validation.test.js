'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validarEstadoOrigemParaEscrita,
    validarEscritaEstrategiaEmOrigem,
    validarEscritaRobo
} = require('../strategy_profile_write_validation');

test('origem vazia é válida e permanece sem perfil', () => {
    const result =
        validarEstadoOrigemParaEscrita({
            mesaId: 1,
            origem: 'Nova',
            estrategias: []
        });

    assert.equal(result.ok, true);
    assert.equal(result.estado, 'EMPTY');
    assert.equal(result.perfil, null);
});

test('origem misturada falha fechada com 409', () => {
    const result =
        validarEstadoOrigemParaEscrita({
            mesaId: 1,
            origem: 'A',
            estrategias: [
                {
                    id: 'a',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: true,
                    is_dinamico: false
                },
                {
                    id: 'b',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 1,
                    proteger_empate: true,
                    is_dinamico: false
                }
            ]
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.erro,
        'ORIGEM_ESTADO_ESTRUTURAL_INVALIDO'
    );
});

test('primeiro padrão define perfil lógico da origem vazia', () => {
    const result =
        validarEscritaEstrategiaEmOrigem({
            estrategia: {
                id: 'novo',
                gales: 2,
                proteger_empate: false
            },
            estrategiasDaOrigem: []
        });

    assert.equal(result.ok, true);

    assert.equal(
        result.perfil,
        'G2_SEM_EMPATE'
    );

    assert.equal(
        result.origem_define_perfil,
        true
    );
});

test('novo padrão incompatível com origem retorna 409 estruturado', () => {
    const result =
        validarEscritaEstrategiaEmOrigem({
            estrategia: {
                id: 'novo',
                gales: 1,
                proteger_empate: true
            },

            estrategiasDaOrigem: [
                {
                    id: 'existente',
                    gales: 2,
                    proteger_empate: true
                }
            ]
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.erro,
        'ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM'
    );

    assert.equal(
        result.body.perfil_esperado,
        'G2_COM_EMPATE'
    );

    assert.equal(
        result.body.perfil_recebido,
        'G1_COM_EMPATE'
    );
});

test('edição do único padrão pode redefinir perfil da origem', () => {
    const result =
        validarEscritaEstrategiaEmOrigem({
            estrategiaIdAtual: 'p1',

            estrategia: {
                id: 'p1',
                gales: 1,
                proteger_empate: false
            },

            estrategiasDaOrigem: [
                {
                    id: 'p1',
                    gales: 2,
                    proteger_empate: true
                }
            ]
        });

    assert.equal(result.ok, true);

    assert.equal(
        result.perfil,
        'G1_SEM_EMPATE'
    );

    assert.equal(
        result.origem_define_perfil,
        true
    );
});

test('edição de um entre vários não pode quebrar homogeneidade', () => {
    const result =
        validarEscritaEstrategiaEmOrigem({
            estrategiaIdAtual: 'p2',

            estrategia: {
                id: 'p2',
                gales: 1,
                proteger_empate: true
            },

            estrategiasDaOrigem: [
                {
                    id: 'p1',
                    gales: 2,
                    proteger_empate: true
                },
                {
                    id: 'p2',
                    gales: 2,
                    proteger_empate: true
                }
            ]
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.perfil_esperado,
        'G2_COM_EMPATE'
    );
});

test('robô homogêneo por origem é aceito', () => {
    const result =
        validarEscritaRobo({
            roboId: 7,
            mesaId: 1,

            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: []
            },

            origens: [
                {
                    id: 1,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'p1',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'p2',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                }
            ]
        });

    assert.equal(result.ok, true);

    assert.equal(
        result.perfil,
        'G2_SEM_EMPATE'
    );

    assert.equal(
        result.total_estrategias,
        2
    );
});

test('robô com origem e avulso incompatíveis retorna 409', () => {
    const result =
        validarEscritaRobo({
            roboId: 7,
            mesaId: 1,

            config: {
                origens: ['A'],
                avulsos: ['fora'],
                excecoes: []
            },

            origens: [
                {
                    id: 1,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'p1',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'fora',
                    mesa_id: 1,
                    origem: 'B',
                    gales: 1,
                    proteger_empate: false,
                    is_dinamico: false
                }
            ]
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.erro,
        'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
    );
});

test('exceção pode remover padrão incompatível e manter robô homogêneo', () => {
    const result =
        validarEscritaRobo({
            roboId: 7,
            mesaId: 1,

            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: ['g1']
            },

            origens: [
                {
                    id: 1,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'g2',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'g1',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 1,
                    proteger_empate: false,
                    is_dinamico: false
                }
            ]
        });

    assert.equal(result.ok, true);

    assert.equal(
        result.perfil,
        'G2_SEM_EMPATE'
    );
});

test('filho IA incompatível é considerado na edição do robô', () => {
    const result =
        validarEscritaRobo({
            roboId: 7,
            mesaId: 1,

            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: []
            },

            origens: [
                {
                    id: 1,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'manual',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'ia-filho',
                    mesa_id: 1,
                    origem: 'IA',
                    gales: 1,
                    proteger_empate: false,
                    is_dinamico: true,
                    robo_dono_id: 7
                }
            ]
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.erro,
        'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
    );
});

test('referência de origem inexistente falha com 409', () => {
    const result =
        validarEscritaRobo({
            roboId: 7,
            mesaId: 1,

            config: {
                origens: ['Fantasma'],
                avulsos: [],
                excecoes: []
            },

            origens: [],

            estrategias: []
        });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    assert.equal(
        result.body.erro,
        'ROBO_REFERENCIAS_INVALIDAS'
    );

    assert.deepEqual(
        [...result.body.origens_inexistentes],
        ['Fantasma']
    );
});
