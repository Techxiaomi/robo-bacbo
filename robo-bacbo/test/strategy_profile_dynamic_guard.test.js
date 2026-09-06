'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    snapshotPosReconciliacao,
    validarFilhosDinamicosDoRobo
} = require('../strategy_profile_dynamic_guard');

function origem(
    id,
    nome,
    mesaId = 1
) {
    return {
        id,
        mesa_id:
            mesaId,
        nome
    };
}

function estrategia({
    id,
    origem,
    gales,
    proteger_empate,
    mesa_id = 1,
    is_dinamico = false,
    robo_dono_id = null
}) {
    return {
        id,
        mesa_id,
        origem,
        gales,
        proteger_empate,
        is_dinamico,
        robo_dono_id
    };
}

function roboBase({
    id = 10,
    nome = 'IA Teste',
    config
} = {}) {
    return {
        id,
        mesa_id: 1,
        nome,

        config:
            config
            ?? {
                origens: ['A'],
                avulsos: [],
                excecoes: [],

                auto_tuning: {
                    ativo: true,
                    gales: 2,
                    proteger_empate: false
                }
            }
    };
}

test(
    'filho IA compatível com perfil do robô é aceito',
    () => {
        const robo =
            roboBase();

        const result =
            validarFilhosDinamicosDoRobo({
                robo,
                mesaId: 1,

                configRobo:
                    robo.config,

                configAutoTuning:
                    robo.config
                        .auto_tuning,

                origens: [
                    origem(1, 'A')
                ],

                estrategias: [
                    estrategia({
                        id: 'manual',
                        origem: 'A',
                        gales: 2,
                        proteger_empate: false
                    })
                ],

                candidatosRetidos: [
                    {
                        id:
                            'ia_10_ok'
                    }
                ]
            });

        assert.equal(
            result.ok,
            true
        );

        assert.equal(
            result.perfil,
            'G2_SEM_EMPATE'
        );

        assert.equal(
            result.total_filhos,
            1
        );
    }
);

test(
    'filho IA é bloqueado quando estado pós-reconciliação quebraria perfil do pai',
    () => {
        const robo =
            roboBase({
                config: {
                    origens: ['A'],
                    avulsos: [],
                    excecoes: [],

                    auto_tuning: {
                        ativo: true,
                        gales: 2,
                        proteger_empate: false
                    }
                }
            });

        const result =
            validarFilhosDinamicosDoRobo({
                robo,
                mesaId: 1,

                configRobo:
                    robo.config,

                configAutoTuning:
                    robo.config
                        .auto_tuning,

                origens: [
                    origem(1, 'A')
                ],

                /*
                 * Estado legado incompatível:
                 * manual G1 enquanto IA está em G2.
                 */
                estrategias: [
                    estrategia({
                        id: 'manual',
                        origem: 'A',
                        gales: 1,
                        proteger_empate: false
                    })
                ],

                candidatosRetidos: [
                    {
                        id:
                            'ia_10_novo'
                    }
                ]
            });

        assert.equal(
            result.ok,
            false
        );

        assert.equal(
            result.erro,
            'AUTO_PILOT_FILHO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
        );

        assert.equal(
            result.robo_id,
            10
        );
    }
);

test(
    'reconciliação substitui virtualmente filhos antigos do mesmo pai antes de validar',
    () => {
        const robo =
            roboBase();

        const snapshot =
            snapshotPosReconciliacao({
                estrategias: [
                    estrategia({
                        id: 'manual',
                        origem: 'A',
                        gales: 2,
                        proteger_empate: false
                    }),

                    /*
                     * Filho legado errado, que será substituído
                     * pelo estado pretendido da reconciliação.
                     */
                    estrategia({
                        id: 'ia_antigo',
                        origem: '[AUTO]',
                        gales: 1,
                        proteger_empate: true,
                        is_dinamico: true,
                        robo_dono_id: 10
                    }),

                    /*
                     * Filho de outro robô deve permanecer.
                     */
                    estrategia({
                        id: 'ia_outro',
                        origem: '[AUTO]',
                        gales: 1,
                        proteger_empate: true,
                        is_dinamico: true,
                        robo_dono_id: 99
                    })
                ],

                candidatosRetidos: [
                    {
                        id:
                            'ia_novo'
                    }
                ],

                robo,
                mesaId: 1,

                configAutoTuning:
                    robo.config
                        .auto_tuning
            });

        const ids =
            snapshot.map(
                item =>
                    String(item.id)
            );

        assert.ok(
            ids.includes(
                'manual'
            )
        );

        assert.ok(
            ids.includes(
                'ia_outro'
            )
        );

        assert.ok(
            ids.includes(
                'ia_novo'
            )
        );

        assert.ok(
            !ids.includes(
                'ia_antigo'
            )
        );

        const novo =
            snapshot.find(
                item =>
                    item.id
                    === 'ia_novo'
            );

        assert.equal(
            novo.gales,
            2
        );

        assert.equal(
            novo.proteger_empate,
            false
        );

        assert.equal(
            novo.is_dinamico,
            true
        );

        assert.equal(
            novo.robo_dono_id,
            10
        );
    }
);

test(
    'sem candidatos retidos o guard permite apenas limpeza do estado antigo',
    () => {
        const result =
            validarFilhosDinamicosDoRobo({
                robo:
                    roboBase(),

                mesaId:
                    1,

                configRobo:
                    {},

                configAutoTuning:
                    {},

                origens:
                    [],

                estrategias:
                    [],

                candidatosRetidos:
                    []
            });

        assert.equal(
            result.ok,
            true
        );

        assert.equal(
            result.motivo,
            'SEM_FILHOS_A_PERSISTIR'
        );
    }
);

test(
    'Auto Pilot executa guard estrutural antes de abrir transação de reconciliação',
    () => {
        const source =
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'auto_pilot_ia.js'
                ),
                'utf8'
            );

        assert.match(
            source,
            /validarFilhosDinamicosDoRobo/
        );

        assert.match(
            source,
            /AUTO_PILOT_FILHO_PERFIL_ESTRUTURAL_INCOMPATIVEL/
        );

        const inicioReconciliar =
            source.indexOf(
                'async function reconciliar('
            );

        const posReter =
            source.indexOf(
                'const reter =',
                inicioReconciliar
            );

        const posGuard =
            source.indexOf(
                'validarFilhosDinamicosDoRobo({',
                posReter
            );

        const posConexao =
            source.indexOf(
                'await dbPool.getConnection()',
                posReter
            );

        const posInsert =
            source.indexOf(
                'INSERT INTO estrategias',
                posReter
            );

        assert.ok(
            inicioReconciliar >= 0
        );

        assert.ok(
            posReter > inicioReconciliar
        );

        assert.ok(
            posGuard > posReter
        );

        assert.ok(
            posConexao > posGuard,
            'guard precisa ocorrer antes de abrir a transação'
        );

        assert.ok(
            posInsert > posConexao,
            'INSERT deve permanecer depois do guard'
        );
    }
);

test(
    'guard estrutural não possui dependência do runtime financeiro',
    () => {
        const source =
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'strategy_profile_dynamic_guard.js'
                ),
                'utf8'
            );

        assert.doesNotMatch(
            source,
            /place_bet|redis_executor|stake_principal|saldo_atual|auditoria_ordens/
        );
    }
);
