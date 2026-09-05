'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    substituirNomeOrigemNoConfig,
    snapshotRenameOrigem,
    validarRenameOrigemEstrutural,
    validarDeleteOrigemEstrutural
} = require('../strategy_profile_route_support');

function estadoBase() {
    return {
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
                nome: 'A1',
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
    'rename substitui somente referencia de origem no config',
    () => {
        const result =
            substituirNomeOrigemNoConfig(
                {
                    origens: ['A', 'B'],
                    avulsos: ['a1'],
                    excecoes: [],
                    extra: 123
                },
                'A',
                'C'
            );

        assert.equal(
            result.ok,
            true
        );

        assert.deepEqual(
            result.config.origens,
            ['C', 'B']
        );

        assert.deepEqual(
            result.config.avulsos,
            ['a1']
        );

        assert.equal(
            result.config.extra,
            123
        );
    }
);

test(
    'snapshot rename troca catalogo e estrategias manuais',
    () => {
        const snap =
            snapshotRenameOrigem({
                estado:
                    estadoBase(),

                origemAnterior:
                    'A',

                origemNova:
                    'C'
            });

        assert.equal(
            snap.origens[0].nome,
            'C'
        );

        assert.equal(
            snap.estrategias[0].origem,
            'C'
        );
    }
);

test(
    'rename atualiza referencia do robo e preserva perfil',
    () => {
        const result =
            validarRenameOrigemEstrutural({
                mesaId: 1,

                origemAnterior:
                    'A',

                origemNova:
                    'C',

                estado:
                    estadoBase(),

                robos: [
                    {
                        id: 10,
                        mesa_id: 1,

                        config_json:
                            JSON.stringify({
                                origens: ['A'],
                                avulsos: [],
                                excecoes: []
                            })
                    }
                ]
            });

        assert.equal(
            result.ok,
            true
        );

        assert.deepEqual(
            result.robos[0]
                .config
                .origens,
            ['C']
        );
    }
);

test(
    'rename falha fechado se config de robo estiver invalida',
    () => {
        const result =
            validarRenameOrigemEstrutural({
                mesaId: 1,
                origemAnterior: 'A',
                origemNova: 'C',
                estado: estadoBase(),

                robos: [
                    {
                        id: 10,
                        mesa_id: 1,
                        config_json:
                            '{invalido'
                    }
                ]
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
            'ORIGEM_RENAME_ROBO_CONFIG_INVALIDA'
        );
    }
);

test(
    'delete bloqueia origem com estrategia manual',
    () => {
        const result =
            validarDeleteOrigemEstrutural({
                mesaId: 1,
                origem: 'A',
                estado: estadoBase(),
                robos: []
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
            'ORIGEM_EM_USO_POR_ESTRATEGIAS'
        );
    }
);

test(
    'delete bloqueia origem referenciada por robo',
    () => {
        const estado =
            estadoBase();

        estado.estrategias = [];

        const result =
            validarDeleteOrigemEstrutural({
                mesaId: 1,
                origem: 'A',
                estado,

                robos: [
                    {
                        id: 10,
                        mesa_id: 1,

                        config_json:
                            JSON.stringify({
                                origens: ['A'],
                                avulsos: [],
                                excecoes: []
                            })
                    }
                ]
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
            'ORIGEM_EM_USO_POR_ROBOS'
        );
    }
);

test(
    'delete aceita origem vazia e sem referencias',
    () => {
        const estado =
            estadoBase();

        estado.estrategias = [];

        const result =
            validarDeleteOrigemEstrutural({
                mesaId: 1,
                origem: 'A',
                estado,
                robos: []
            });

        assert.equal(
            result.ok,
            true
        );
    }
);

test(
    'rotas de origem validam antes do primeiro write',
    () => {
        const fs =
            require('fs');

        const path =
            require('path');

        const source =
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'bot2_coletor.js'
                ),
                'utf8'
            );

        const putIni =
            source.indexOf(
                'app.put("/api/origem/:id"'
            );

        const delIni =
            source.indexOf(
                'app.delete("/api/origem/:id"',
                putIni
            );

        const put =
            source.slice(
                putIni,
                delIni
            );

        assert.ok(
            put.indexOf(
                'validarRenameOrigemEstrutural({'
            ) >= 0
        );

        assert.ok(
            put.indexOf(
                'validarRenameOrigemEstrutural({'
            )
            <
            put.indexOf(
                'UPDATE origens'
            )
        );

        const getRobos =
            source.indexOf(
                'app.get("/api/robos"',
                delIni
            );

        const del =
            source.slice(
                delIni,
                getRobos
            );

        assert.ok(
            del.indexOf(
                'validarDeleteOrigemEstrutural({'
            ) >= 0
        );

        assert.ok(
            del.indexOf(
                'validarDeleteOrigemEstrutural({'
            )
            <
            del.indexOf(
                'DELETE FROM origens'
            )
        );
    }
);
