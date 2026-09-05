'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validarCriacaoEstrategiaRoute,
    validarEdicaoEstrategiaRoute,
    validarCriacaoRoboRoute,
    validarEdicaoRoboRoute
} = require('../strategy_profile_route_support');

function poolFake({
    origens = [],
    estrategias = []
} = {}) {
    const queries = [];

    return {
        queries,

        async query(sql, params = []) {
            const q = String(sql)
                .replace(/\s+/g, ' ')
                .trim();

            queries.push({
                sql: q,
                params: [...params]
            });

            if (!/^SELECT\b/i.test(q)) {
                throw new Error(
                    `WRITE_NAO_PERMITIDO_NO_FAKE: ${q}`
                );
            }

            if (
                /FROM origens/i.test(q)
                && /AND nome=\?/i.test(q)
            ) {
                const [mesaId, nome] = params;

                return [[
                    ...origens.filter(
                        row =>
                            Number(row.mesa_id)
                                === Number(mesaId)
                            && String(row.nome)
                                === String(nome)
                    ).slice(0, 1)
                ]];
            }

            if (
                /FROM origens/i.test(q)
                && /WHERE mesa_id=\?/i.test(q)
            ) {
                const [mesaId] = params;

                return [[
                    ...origens.filter(
                        row =>
                            Number(row.mesa_id)
                                === Number(mesaId)
                    )
                ]];
            }

            if (
                /FROM estrategias/i.test(q)
                && /AND id=\?/i.test(q)
                && /is_dinamico=false/i.test(q)
            ) {
                const [
                    mesaId,
                    estrategiaId
                ] = params;

                return [[
                    ...estrategias.filter(
                        row =>
                            Number(row.mesa_id)
                                === Number(mesaId)
                            && String(row.id)
                                === String(estrategiaId)
                            && !row.is_dinamico
                    ).slice(0, 1)
                ]];
            }

            if (
                /FROM estrategias/i.test(q)
                && /AND origem=\?/i.test(q)
                && /is_dinamico=false/i.test(q)
            ) {
                const [mesaId, origem] = params;

                return [[
                    ...estrategias.filter(
                        row =>
                            Number(row.mesa_id)
                                === Number(mesaId)
                            && String(row.origem)
                                === String(origem)
                            && !row.is_dinamico
                    )
                ]];
            }

            if (
                /FROM estrategias/i.test(q)
                && /WHERE mesa_id=\?/i.test(q)
            ) {
                const [mesaId] = params;

                return [[
                    ...estrategias.filter(
                        row =>
                            Number(row.mesa_id)
                                === Number(mesaId)
                    )
                ]];
            }

            throw new Error(
                `QUERY_FAKE_NAO_RECONHECIDA: ${q}`
            );
        }
    };
}

test('criação compatível com origem é aceita', async () => {
    const dbPool = poolFake({
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
                proteger_empate: true,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarCriacaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategia: {
                origem: 'A',
                gales: 2,
                proteger_empate: true
            }
        });

    assert.equal(r.ok, true);
    assert.equal(
        r.perfil,
        'G2_COM_EMPATE'
    );
});

test('criação incompatível retorna 409', async () => {
    const dbPool = poolFake({
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
                proteger_empate: true,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarCriacaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategia: {
                origem: 'A',
                gales: 1,
                proteger_empate: true
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);

    assert.equal(
        r.body.erro,
        'ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM'
    );
});

test('origem inexistente retorna 409', async () => {
    const dbPool = poolFake();

    const r =
        await validarCriacaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategia: {
                origem: 'Fantasma',
                gales: 2,
                proteger_empate: false
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);

    assert.equal(
        r.body.erro,
        'ESTRATEGIA_ORIGEM_INEXISTENTE'
    );
});

test('edição do único padrão pode redefinir a origem', async () => {
    const dbPool = poolFake({
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
                proteger_empate: true,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarEdicaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategiaId: 'p1',
            estrategia: {
                id: 'p1',
                origem: 'A',
                gales: 1,
                proteger_empate: false
            }
        });

    assert.equal(r.ok, true);

    assert.equal(
        r.perfil,
        'G1_SEM_EMPATE'
    );
});

test('edição entre vários não quebra homogeneidade', async () => {
    const dbPool = poolFake({
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
                proteger_empate: true,
                is_dinamico: false
            },
            {
                id: 'p2',
                mesa_id: 1,
                origem: 'A',
                gales: 2,
                proteger_empate: true,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarEdicaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategiaId: 'p2',
            estrategia: {
                id: 'p2',
                origem: 'A',
                gales: 1,
                proteger_empate: true
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
});

test('mudança de origem é comparada contra a origem destino', async () => {
    const dbPool = poolFake({
        origens: [
            {
                id: 1,
                mesa_id: 1,
                nome: 'A'
            },
            {
                id: 2,
                mesa_id: 1,
                nome: 'B'
            }
        ],
        estrategias: [
            {
                id: 'movido',
                mesa_id: 1,
                origem: 'A',
                gales: 2,
                proteger_empate: true,
                is_dinamico: false
            },
            {
                id: 'b1',
                mesa_id: 1,
                origem: 'B',
                gales: 1,
                proteger_empate: true,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarEdicaoEstrategiaRoute({
            dbPool,
            mesaId: 1,
            estrategiaId: 'movido',
            estrategia: {
                id: 'movido',
                origem: 'B',
                gales: 2,
                proteger_empate: true
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);

    assert.equal(
        r.body.perfil_esperado,
        'G1_COM_EMPATE'
    );
});

test('robô homogêneo é aceito', async () => {
    const dbPool = poolFake({
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
            }
        ]
    });

    const r =
        await validarCriacaoRoboRoute({
            dbPool,
            mesaId: 1,
            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: []
            }
        });

    assert.equal(r.ok, true);

    assert.equal(
        r.perfil,
        'G2_SEM_EMPATE'
    );
});

test('robô com avulso incompatível retorna 409', async () => {
    const dbPool = poolFake({
        origens: [
            {
                id: 1,
                mesa_id: 1,
                nome: 'A'
            },
            {
                id: 2,
                mesa_id: 1,
                nome: 'B'
            }
        ],
        estrategias: [
            {
                id: 'a1',
                mesa_id: 1,
                origem: 'A',
                gales: 2,
                proteger_empate: false,
                is_dinamico: false
            },
            {
                id: 'b1',
                mesa_id: 1,
                origem: 'B',
                gales: 1,
                proteger_empate: false,
                is_dinamico: false
            }
        ]
    });

    const r =
        await validarCriacaoRoboRoute({
            dbPool,
            mesaId: 1,
            config: {
                origens: ['A'],
                avulsos: ['b1'],
                excecoes: []
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);

    assert.equal(
        r.body.erro,
        'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
    );
});

test('edição de robô inclui filho IA pelo robo_dono_id', async () => {
    const dbPool = poolFake({
        origens: [
            {
                id: 1,
                mesa_id: 28,
                nome: 'A'
            }
        ],
        estrategias: [
            {
                id: 'manual',
                mesa_id: 28,
                origem: 'A',
                gales: 2,
                proteger_empate: false,
                is_dinamico: false
            },
            {
                id: 'ia',
                mesa_id: 28,
                origem: 'IA',
                gales: 1,
                proteger_empate: false,
                is_dinamico: true,
                robo_dono_id: 15
            }
        ]
    });

    const r =
        await validarEdicaoRoboRoute({
            dbPool,
            mesaId: 28,
            roboId: 15,
            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: []
            }
        });

    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
});

test('route support realizou somente SELECTs', async () => {
    const dbPool = poolFake({
        origens: [
            {
                id: 1,
                mesa_id: 1,
                nome: 'A'
            }
        ]
    });

    await validarCriacaoEstrategiaRoute({
        dbPool,
        mesaId: 1,
        estrategia: {
            origem: 'A',
            gales: 2,
            proteger_empate: false
        }
    });

    assert.ok(
        dbPool.queries.length >= 2
    );

    for (const query of dbPool.queries) {
        assert.match(
            query.sql,
            /^SELECT\b/i
        );
    }
});


test('criação de robô considera auto-tuning ativo antes da mineração', async () => {
    const dbPool =
        poolFake({
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
                }
            ]
        });

    const result =
        await validarCriacaoRoboRoute({
            dbPool,
            mesaId: 1,

            config: {
                origens: ['A'],
                avulsos: [],
                excecoes: [],

                auto_tuning: {
                    ativo: true,
                    gales: 1,
                    proteger_empate: false
                }
            }
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
        'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
    );
});
