'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    booleanoEstrito,
    perfilDaEstrategia,
    perfisIguais,
    analisarConjuntoPerfis,
    parseConfigRobo,
    roboSintonizaEstrategia
} = require('../strategy_profile_policy');

test('booleano estrutural aceita somente representações conhecidas', () => {
    assert.equal(booleanoEstrito(true), true);
    assert.equal(booleanoEstrito(false), false);
    assert.equal(booleanoEstrito(1), true);
    assert.equal(booleanoEstrito(0), false);
    assert.equal(booleanoEstrito('true'), true);
    assert.equal(booleanoEstrito('false'), false);
    assert.equal(booleanoEstrito('talvez'), null);
});

test('assinatura canônica combina gale e proteção de empate', () => {
    assert.equal(
        perfilDaEstrategia({
            gales: 2,
            proteger_empate: false
        }).signature,
        'G2_SEM_EMPATE'
    );

    assert.equal(
        perfilDaEstrategia({
            gales: 1,
            proteger_empate: true
        }).signature,
        'G1_COM_EMPATE'
    );
});

test('perfil rejeita gales fora do domínio', () => {
    const perfil =
        perfilDaEstrategia({
            gales: 3,
            proteger_empate: true
        });

    assert.equal(perfil.ok, false);
    assert.equal(
        perfil.reason,
        'GALES_INVALIDO'
    );
});

test('perfis iguais dependem da assinatura canônica', () => {
    const a =
        perfilDaEstrategia({
            gales: 2,
            proteger_empate: 1
        });

    const b =
        perfilDaEstrategia({
            gales: '2',
            proteger_empate: 'true'
        });

    const c =
        perfilDaEstrategia({
            gales: 2,
            proteger_empate: false
        });

    assert.equal(
        perfisIguais(a, b),
        true
    );

    assert.equal(
        perfisIguais(a, c),
        false
    );
});

test('análise distingue EMPTY CONSISTENT INCONSISTENT e INVALID', () => {
    assert.equal(
        analisarConjuntoPerfis([])
            .status,
        'EMPTY'
    );

    assert.equal(
        analisarConjuntoPerfis([
            {
                id: 'a',
                gales: 2,
                proteger_empate: false
            },
            {
                id: 'b',
                gales: 2,
                proteger_empate: false
            }
        ]).status,
        'CONSISTENT'
    );

    assert.equal(
        analisarConjuntoPerfis([
            {
                id: 'a',
                gales: 2,
                proteger_empate: false
            },
            {
                id: 'b',
                gales: 1,
                proteger_empate: false
            }
        ]).status,
        'INCONSISTENT'
    );

    assert.equal(
        analisarConjuntoPerfis([
            {
                id: 'x',
                gales: 9,
                proteger_empate: false
            }
        ]).status,
        'INVALID'
    );
});

test('config do robô normaliza listas sem duplicatas', () => {
    const parsed =
        parseConfigRobo({
            origens: [
                'Origem A',
                'Origem A'
            ],
            avulsos: [
                'p1',
                'p1'
            ],
            excecoes: [
                'p2'
            ]
        });

    assert.equal(parsed.ok, true);

    assert.deepEqual(
        [...parsed.config.origens],
        ['Origem A']
    );

    assert.deepEqual(
        [...parsed.config.avulsos],
        ['p1']
    );
});

test('sintonia preserva exceção antes de avulso e origem', () => {
    const robo = {
        id: 7,
        mesa_id: 1
    };

    const config = {
        origens: ['A'],
        avulsos: ['avulso'],
        excecoes: ['bloqueado']
    };

    assert.equal(
        roboSintonizaEstrategia(
            robo,
            {
                id: 'normal',
                mesa_id: 1,
                origem: 'A',
                is_dinamico: false
            },
            config
        ),
        true
    );

    assert.equal(
        roboSintonizaEstrategia(
            robo,
            {
                id: 'bloqueado',
                mesa_id: 1,
                origem: 'A',
                is_dinamico: false
            },
            config
        ),
        false
    );

    assert.equal(
        roboSintonizaEstrategia(
            robo,
            {
                id: 'avulso',
                mesa_id: 1,
                origem: 'B',
                is_dinamico: false
            },
            config
        ),
        true
    );
});

test('padrão dinâmico é selecionado exclusivamente pelo robo_dono_id', () => {
    const estrategia = {
        id: 'ia-x',
        mesa_id: 1,
        is_dinamico: true,
        robo_dono_id: 7
    };

    const config = {
        origens: [],
        avulsos: [],
        excecoes: []
    };

    assert.equal(
        roboSintonizaEstrategia(
            {
                id: 7,
                mesa_id: 1
            },
            estrategia,
            config
        ),
        true
    );

    assert.equal(
        roboSintonizaEstrategia(
            {
                id: 8,
                mesa_id: 1
            },
            estrategia,
            config
        ),
        false
    );
});
