'use strict';

const {
    validarEscritaEstrategiaEmOrigem,
    validarEscritaRobo
} = require('./strategy_profile_write_validation');

const {
    parseConfigRobo,
    selecionarEstrategiasDoRobo
} = require('./strategy_profile_policy');

function ok(extra = {}) {
    return Object.freeze({
        ok: true,
        status: 200,
        ...extra
    });
}

function conflito(erro, detalhe = {}) {
    return Object.freeze({
        ok: false,
        status: 409,
        body: Object.freeze({
            sucesso: false,
            erro,
            ...detalhe
        })
    });
}

async function buscarOrigem({
    dbPool,
    mesaId,
    origem
}) {
    const nome = String(origem ?? '').trim();

    const [rows] = await dbPool.query(
        `SELECT id, mesa_id, nome
         FROM origens
         WHERE mesa_id=?
           AND nome=?
         LIMIT 1`,
        [Number(mesaId), nome]
    );

    return (
        Array.isArray(rows)
        && rows.length === 1
    )
        ? rows[0]
        : null;
}

async function buscarEstrategiaManual({
    dbPool,
    mesaId,
    estrategiaId
}) {
    const [rows] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
           AND id=?
           AND is_dinamico=false
         LIMIT 1`,
        [
            Number(mesaId),
            String(estrategiaId ?? '')
        ]
    );

    return (
        Array.isArray(rows)
        && rows.length === 1
    )
        ? rows[0]
        : null;
}

async function listarEstrategiasManuaisDaOrigem({
    dbPool,
    mesaId,
    origem
}) {
    const [rows] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
           AND origem=?
           AND is_dinamico=false
         ORDER BY id`,
        [
            Number(mesaId),
            String(origem ?? '').trim()
        ]
    );

    return Array.isArray(rows)
        ? rows
        : [];
}

async function carregarMesaEstrutural({
    dbPool,
    mesaId
}) {
    const [origens] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome
         FROM origens
         WHERE mesa_id=?
         ORDER BY id`,
        [Number(mesaId)]
    );

    const [estrategias] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            ativo,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
         ORDER BY origem, id`,
        [Number(mesaId)]
    );

    return Object.freeze({
        origens: Array.isArray(origens)
            ? origens
            : [],

        estrategias: Array.isArray(estrategias)
            ? estrategias
            : []
    });
}

async function listarRobosEstruturais({
    dbPool,
    mesaId
}) {
    const [rows] =
        await dbPool.query(
            `SELECT
                id,
                mesa_id,
                nome,
                config_json
             FROM robos_canais
             WHERE mesa_id=?
             ORDER BY id`,
            [
                Number(mesaId)
            ]
        );

    return Array.isArray(rows)
        ? rows
        : [];
}

function substituirEstrategiaNoSnapshot({
    estrategias,
    estrategiaId,
    estrategiaNova,
    mesaId
}) {
    const alvo =
        String(
            estrategiaId ?? ''
        );

    return (
        Array.isArray(estrategias)
            ? estrategias
            : []
    ).map(item => {
        if (
            String(item?.id ?? '')
            !== alvo
        ) {
            return item;
        }

        return Object.freeze({
            ...item,
            ...estrategiaNova,

            id:
                alvo,

            mesa_id:
                Number(mesaId),

            origem:
                String(
                    estrategiaNova
                        ?.origem
                    ?? item?.origem
                    ?? ''
                ).trim(),

            gales:
                estrategiaNova
                    ?.gales,

            proteger_empate:
                estrategiaNova
                    ?.proteger_empate,

            is_dinamico:
                false
        });
    });
}

function idsSelecionados({
    robo,
    config,
    estrategias
}) {
    return new Set(
        selecionarEstrategiasDoRobo({
            robo,
            config,
            estrategias
        }).map(
            item =>
                String(
                    item?.id ?? ''
                )
        )
    );
}

async function validarImpactoGlobalEdicaoEstrategia({
    dbPool,
    mesaId,
    estrategiaId,
    estrategia,
    atual
}) {
    const estado =
        await carregarMesaEstrutural({
            dbPool,
            mesaId
        });

    const robos =
        await listarRobosEstruturais({
            dbPool,
            mesaId
        });

    const estrategiaAlvo =
        String(
            estrategiaId ?? ''
        );

    const snapshotNovo =
        substituirEstrategiaNoSnapshot({
            estrategias:
                estado.estrategias,

            estrategiaId:
                estrategiaAlvo,

            estrategiaNova:
                estrategia,

            mesaId
        });

    const impactos = [];

    for (const robo of robos) {
        const parsed =
            parseConfigRobo(
                robo?.config_json
            );

        /*
         * Integridade global é fail-closed.
         *
         * Se a configuração persistida do robô não pode
         * ser interpretada, não existe prova suficiente
         * de que a edição da estratégia é segura.
         */
        if (!parsed.ok) {
            return conflito(
                'ESTRATEGIA_IMPACTO_GLOBAL_INDETERMINADO',
                {
                    estrategia_id:
                        String(
                            estrategiaId ?? ''
                        ),

                    motivo:
                        String(
                            parsed.reason
                            ?? 'ROBO_CONFIG_INVALIDA'
                        ),

                    robos_nao_avaliados: [
                        Object.freeze({
                            id:
                                Number(robo.id),

                            nome:
                                String(
                                    robo?.nome ?? ''
                                )
                        })
                    ],

                    total_robos_nao_avaliados:
                        1
                }
            );
        }

        const roboVirtual = {
            id:
                Number(robo.id),

            mesa_id:
                Number(mesaId)
        };

        const antes =
            idsSelecionados({
                robo:
                    roboVirtual,

                config:
                    parsed.config,

                estrategias:
                    estado.estrategias
            });

        const depois =
            idsSelecionados({
                robo:
                    roboVirtual,

                config:
                    parsed.config,

                estrategias:
                    snapshotNovo
            });

        /*
         * O robô só pertence ao universo de impacto
         * quando efetivamente sintoniza a estratégia
         * antes ou depois da alteração.
         *
         * Isso cobre:
         * - origem;
         * - avulso / mapeamento direto;
         * - mudança de origem que passa a incluí-la;
         * - exceção, que corretamente a remove.
         */
        if (
            !antes.has(
                estrategiaAlvo
            )
            && !depois.has(
                estrategiaAlvo
            )
        ) {
            continue;
        }

        const validacaoAntes =
            validarEscritaRobo({
                roboId:
                    robo.id,

                mesaId,

                config:
                    parsed.config,

                origens:
                    estado.origens,

                estrategias:
                    estado.estrategias
            });

        const validacaoDepois =
            validarEscritaRobo({
                roboId:
                    robo.id,

                mesaId,

                config:
                    parsed.config,

                origens:
                    estado.origens,

                estrategias:
                    snapshotNovo
            });

        /*
         * O gate desta etapa protege contra uma NOVA
         * incompatibilidade introduzida pela edição.
         * Não sequestra a operação por uma inconsistência
         * legada e não relacionada que já existisse antes.
         */
        if (
            validacaoAntes.ok
            && !validacaoDepois.ok
        ) {
            impactos.push(
                Object.freeze({
                    id:
                        Number(robo.id),

                    nome:
                        String(
                            robo?.nome ?? ''
                        ),

                    estado:
                        String(
                            validacaoDepois
                                ?.body
                                ?.estado
                            ?? 'INCOMPATIVEL'
                        ),

                    erro:
                        String(
                            validacaoDepois
                                ?.body
                                ?.erro
                            ?? 'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL'
                        ),

                    perfis_encontrados:
                        Array.isArray(
                            validacaoDepois
                                ?.body
                                ?.perfis_encontrados
                        )
                            ? validacaoDepois
                                .body
                                .perfis_encontrados
                            : [],

                    estrategias_invalidas:
                        Array.isArray(
                            validacaoDepois
                                ?.body
                                ?.estrategias_invalidas
                        )
                            ? validacaoDepois
                                .body
                                .estrategias_invalidas
                            : []
                })
            );
        }
    }

    if (impactos.length === 0) {
        return ok({
            estrategia_id:
                estrategiaAlvo,

            robos_impactados:
                Object.freeze([]),

            total_robos_impactados:
                0
        });
    }

    return conflito(
        'ESTRATEGIA_IMPACTA_ROBOS_INCOMPATIVEIS',
        {
            estrategia_id:
                estrategiaAlvo,

            perfil_anterior: {
                gales:
                    atual?.gales,

                proteger_empate:
                    atual
                        ?.proteger_empate,

                origem:
                    String(
                        atual?.origem ?? ''
                    )
            },

            perfil_novo: {
                gales:
                    estrategia?.gales,

                proteger_empate:
                    estrategia
                        ?.proteger_empate,

                origem:
                    String(
                        estrategia
                            ?.origem
                        ?? ''
                    ).trim()
            },

            robos_impactados:
                Object.freeze(
                    impactos
                ),

            total_robos_impactados:
                impactos.length
        }
    );
}

async function validarCriacaoEstrategiaRoute({
    dbPool,
    mesaId,
    estrategia
}) {
    const origemNome =
        String(estrategia?.origem ?? '').trim();

    const origem = await buscarOrigem({
        dbPool,
        mesaId,
        origem: origemNome
    });

    if (!origem) {
        return conflito(
            'ESTRATEGIA_ORIGEM_INEXISTENTE',
            {
                origem: origemNome
            }
        );
    }

    const existentes =
        await listarEstrategiasManuaisDaOrigem({
            dbPool,
            mesaId,
            origem: origemNome
        });

    return validarEscritaEstrategiaEmOrigem({
        estrategia,
        estrategiasDaOrigem: existentes
    });
}

async function validarEdicaoEstrategiaRoute({
    dbPool,
    mesaId,
    estrategiaId,
    estrategia
}) {
    const atual =
        await buscarEstrategiaManual({
            dbPool,
            mesaId,
            estrategiaId
        });

    /*
     * A rota antiga é responsável pelo 404.
     * Não transformamos inexistência em conflito estrutural.
     */
    if (!atual) {
        return ok({
            existente: false
        });
    }

    const origemDestino =
        String(estrategia?.origem ?? '').trim();

    const origem = await buscarOrigem({
        dbPool,
        mesaId,
        origem: origemDestino
    });

    if (!origem) {
        return conflito(
            'ESTRATEGIA_ORIGEM_INEXISTENTE',
            {
                origem: origemDestino,
                origem_anterior:
                    String(atual.origem ?? '').trim()
            }
        );
    }

    const destino =
        await listarEstrategiasManuaisDaOrigem({
            dbPool,
            mesaId,
            origem: origemDestino
        });

    const validacao =
        validarEscritaEstrategiaEmOrigem({
            estrategia,
            estrategiasDaOrigem: destino,
            estrategiaIdAtual:
                estrategiaId
        });

    if (!validacao.ok) {
        return validacao;
    }

    const impactoGlobal =
        await validarImpactoGlobalEdicaoEstrategia({
            dbPool,
            mesaId,
            estrategiaId,
            estrategia,
            atual
        });

    if (!impactoGlobal.ok) {
        return impactoGlobal;
    }

    return Object.freeze({
        ...validacao,
        existente: true,
        origem_anterior:
            String(atual.origem ?? '').trim(),
        origem_destino:
            origemDestino,
        mudou_origem:
            String(atual.origem ?? '').trim()
            !== origemDestino,
        total_robos_impactados: 0
    });
}

async function validarCriacaoRoboRoute({
    dbPool,
    mesaId,
    config
}) {
    const estado =
        await carregarMesaEstrutural({
            dbPool,
            mesaId
        });

    return validarEscritaRobo({
        roboId: null,
        mesaId,
        config,
        origens: estado.origens,
        estrategias: estado.estrategias
    });
}

async function validarEdicaoRoboRoute({
    dbPool,
    mesaId,
    roboId,
    config
}) {
    const estado =
        await carregarMesaEstrutural({
            dbPool,
            mesaId
        });

    return validarEscritaRobo({
        roboId,
        mesaId,
        config,
        origens: estado.origens,
        estrategias: estado.estrategias
    });
}

module.exports = {
    buscarOrigem,
    buscarEstrategiaManual,
    listarEstrategiasManuaisDaOrigem,
    carregarMesaEstrutural,
    listarRobosEstruturais,
    substituirEstrategiaNoSnapshot,
    validarImpactoGlobalEdicaoEstrategia,

    validarCriacaoEstrategiaRoute,
    validarEdicaoEstrategiaRoute,

    validarCriacaoRoboRoute,
    validarEdicaoRoboRoute
};
