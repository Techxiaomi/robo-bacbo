'use strict';

const {
    dinamico,
    perfilDaEstrategia,
    perfisIguais,
    analisarConjuntoPerfis,
    parseConfigRobo,
    selecionarEstrategiasDoRobo,
    estrategiasManuaisDaOrigem
} = require('./strategy_profile_policy');

function resultadoOk(extra = {}) {
    return Object.freeze({
        ok: true,
        status: 200,
        ...extra
    });
}

function erroEstruturado(
    status,
    erro,
    detalhe = {}
) {
    return Object.freeze({
        ok: false,
        status,

        body:
            Object.freeze({
                sucesso: false,
                erro,
                ...detalhe
            })
    });
}

function validarEstadoOrigemParaEscrita({
    mesaId,
    origem,
    estrategias
}) {
    const selecionadas =
        estrategiasManuaisDaOrigem({
            mesaId,
            origem,
            estrategias
        });

    const audit =
        analisarConjuntoPerfis(
            selecionadas
        );

    if (
        audit.status === 'INVALID'
        || audit.status === 'INCONSISTENT'
    ) {
        return erroEstruturado(
            409,
            'ORIGEM_ESTADO_ESTRUTURAL_INVALIDO',
            {
                origem:
                    String(
                        origem ?? ''
                    ).trim(),

                estado:
                    audit.status,

                perfis_encontrados:
                    audit.profiles,

                estrategias_invalidas:
                    audit.invalid_strategies
            }
        );
    }

    return resultadoOk({
        origem:
            String(
                origem ?? ''
            ).trim(),

        estado:
            audit.status,

        perfil:
            audit.canonical_profile,

        total_estrategias:
            audit.total_strategies
    });
}

function validarEscritaEstrategiaEmOrigem({
    estrategia,
    estrategiasDaOrigem,
    estrategiaIdAtual = null
}) {
    const perfilRecebido =
        perfilDaEstrategia(
            estrategia
        );

    if (!perfilRecebido.ok) {
        return erroEstruturado(
            400,
            'ESTRATEGIA_PERFIL_ESTRUTURAL_INVALIDO',
            {
                motivo:
                    perfilRecebido.reason
            }
        );
    }

    const idAtual =
        estrategiaIdAtual == null
            ? null
            : String(
                estrategiaIdAtual
            );

    const demais =
        (
            Array.isArray(
                estrategiasDaOrigem
            )
                ? estrategiasDaOrigem
                : []
        ).filter(
            item =>
                idAtual == null
                || String(
                    item?.id ?? ''
                ) !== idAtual
        );

    const estadoAtual =
        analisarConjuntoPerfis(
            demais
        );

    if (
        estadoAtual.status === 'INVALID'
        || estadoAtual.status ===
            'INCONSISTENT'
    ) {
        return erroEstruturado(
            409,
            'ORIGEM_ESTADO_ESTRUTURAL_INVALIDO',
            {
                estado:
                    estadoAtual.status,

                perfis_encontrados:
                    estadoAtual.profiles,

                estrategias_invalidas:
                    estadoAtual.invalid_strategies
            }
        );
    }

    if (
        estadoAtual.status === 'EMPTY'
    ) {
        return resultadoOk({
            perfil:
                perfilRecebido.signature,

            perfil_objeto:
                perfilRecebido,

            origem_define_perfil:
                true
        });
    }

    const perfilEsperado =
        estadoAtual.canonical_profile;

    if (
        perfilEsperado
        !== perfilRecebido.signature
    ) {
        return erroEstruturado(
            409,
            'ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM',
            {
                perfil_esperado:
                    perfilEsperado,

                perfil_recebido:
                    perfilRecebido.signature
            }
        );
    }

    return resultadoOk({
        perfil:
            perfilEsperado,

        perfil_objeto:
            perfilRecebido,

        origem_define_perfil:
            false
    });
}

function validarReferenciasRobo({
    mesaId,
    config,
    origens,
    estrategias
}) {
    const origensMesa =
        new Set(
            (
                Array.isArray(origens)
                    ? origens
                    : []
            )
                .filter(
                    item =>
                        Number(
                            item?.mesa_id
                        ) ===
                        Number(mesaId)
                )
                .map(
                    item =>
                        String(
                            item?.nome ?? ''
                        ).trim()
                )
                .filter(Boolean)
        );

    const estrategiasMesa =
        new Set(
            (
                Array.isArray(estrategias)
                    ? estrategias
                    : []
            )
                .filter(
                    item =>
                        Number(
                            item?.mesa_id
                        ) ===
                        Number(mesaId)
                )
                .map(
                    item =>
                        String(
                            item?.id ?? ''
                        )
                )
        );

    const origensAusentes =
        config.origens.filter(
            origem =>
                !origensMesa.has(origem)
        );

    const idsReferenciados =
        [
            ...config.avulsos,
            ...config.excecoes
        ];

    const estrategiasAusentes =
        [
            ...new Set(
                idsReferenciados.filter(
                    id =>
                        !estrategiasMesa.has(id)
                )
            )
        ];

    if (
        origensAusentes.length > 0
        || estrategiasAusentes.length > 0
    ) {
        return erroEstruturado(
            409,
            'ROBO_REFERENCIAS_INVALIDAS',
            {
                origens_inexistentes:
                    Object.freeze(
                        [...origensAusentes]
                    ),

                estrategias_inexistentes:
                    Object.freeze(
                        [...estrategiasAusentes]
                    )
            }
        );
    }

    return resultadoOk();
}

function validarEscritaRobo({
    roboId = null,
    mesaId,
    config,
    origens,
    estrategias
}) {
    const parsedConfig =
        parseConfigRobo(config);

    if (!parsedConfig.ok) {
        return erroEstruturado(
            400,
            'ROBO_CONFIG_ESTRUTURAL_INVALIDA',
            {
                motivo:
                    parsedConfig.reason
            }
        );
    }

    const configNormalizada =
        parsedConfig.config;

    const refs =
        validarReferenciasRobo({
            mesaId,
            config:
                configNormalizada,
            origens,
            estrategias
        });

    if (!refs.ok) {
        return refs;
    }

    const roboVirtual = {
        id:
            roboId == null
                ? null
                : Number(roboId),

        mesa_id:
            Number(mesaId)
    };

    const selecionadas =
        selecionarEstrategiasDoRobo({
            robo:
                roboVirtual,

            config:
                configNormalizada,

            estrategias
        });

    const audit =
        analisarConjuntoPerfis(
            selecionadas
        );

    if (
        audit.status === 'INVALID'
        || audit.status ===
            'INCONSISTENT'
    ) {
        return erroEstruturado(
            409,
            'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL',
            {
                estado:
                    audit.status,

                perfis_encontrados:
                    audit.profiles,

                estrategias_invalidas:
                    audit.invalid_strategies,

                total_estrategias:
                    audit.total_strategies
            }
        );
    }

    return resultadoOk({
        perfil:
            audit.canonical_profile,

        estado:
            audit.status,

        total_estrategias:
            audit.total_strategies,

        config:
            configNormalizada,

        estrategias:
            Object.freeze(
                selecionadas.map(
                    item =>
                        Object.freeze({
                            id:
                                String(
                                    item?.id ?? ''
                                ),

                            origem:
                                String(
                                    item?.origem ?? ''
                                ),

                            dinamico:
                                dinamico(
                                    item?.is_dinamico
                                ),

                            perfil:
                                perfilDaEstrategia(
                                    item
                                ).signature
                        })
                )
            )
    });
}

module.exports = {
    resultadoOk,
    erroEstruturado,

    validarEstadoOrigemParaEscrita,
    validarEscritaEstrategiaEmOrigem,

    validarReferenciasRobo,
    validarEscritaRobo
};
