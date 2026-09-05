'use strict';

const VALID_GALES = Object.freeze(
    new Set([0, 1, 2])
);

function booleanoEstrito(valor) {
    if (
        valor === true
        || valor === 1
        || valor === '1'
    ) {
        return true;
    }

    if (
        valor === false
        || valor === 0
        || valor === '0'
    ) {
        return false;
    }

    const normalizado = String(valor ?? '')
        .trim()
        .toLowerCase();

    if (normalizado === 'true') {
        return true;
    }

    if (normalizado === 'false') {
        return false;
    }

    return null;
}

function dinamico(valor) {
    return booleanoEstrito(valor) === true;
}

function normalizarListaStrings(valor) {
    if (!Array.isArray(valor)) {
        return [];
    }

    return [
        ...new Set(
            valor
                .map(
                    item =>
                        String(item ?? '').trim()
                )
                .filter(Boolean)
        )
    ];
}

function perfilDaEstrategia(estrategia) {
    const gales =
        Number(estrategia?.gales);

    const protegerEmpate =
        booleanoEstrito(
            estrategia?.proteger_empate
        );

    if (
        !Number.isInteger(gales)
        || !VALID_GALES.has(gales)
    ) {
        return Object.freeze({
            ok: false,
            signature: null,
            gales: null,
            proteger_empate: null,
            reason: 'GALES_INVALIDO'
        });
    }

    if (protegerEmpate == null) {
        return Object.freeze({
            ok: false,
            signature: null,
            gales,
            proteger_empate: null,
            reason:
                'PROTEGER_EMPATE_INVALIDO'
        });
    }

    const signature =
        `G${gales}_${
            protegerEmpate
                ? 'COM_EMPATE'
                : 'SEM_EMPATE'
        }`;

    return Object.freeze({
        ok: true,
        signature,
        gales,
        proteger_empate:
            protegerEmpate,
        reason: null
    });
}

function perfisIguais(a, b) {
    if (!a?.ok || !b?.ok) {
        return false;
    }

    return (
        a.signature === b.signature
    );
}

function analisarConjuntoPerfis(
    estrategias
) {
    const lista =
        Array.isArray(estrategias)
            ? estrategias
            : [];

    const contagem =
        new Map();

    const invalidas = [];

    for (const estrategia of lista) {
        const perfil =
            perfilDaEstrategia(
                estrategia
            );

        if (!perfil.ok) {
            invalidas.push(
                Object.freeze({
                    id:
                        String(
                            estrategia?.id ?? ''
                        ),

                    nome:
                        String(
                            estrategia?.nome ?? ''
                        ),

                    reason:
                        perfil.reason
                })
            );

            continue;
        }

        contagem.set(
            perfil.signature,

            (
                contagem.get(
                    perfil.signature
                )
                || 0
            ) + 1
        );
    }

    const profiles =
        [...contagem.entries()]
            .sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            )
            .map(
                ([signature, count]) =>
                    Object.freeze({
                        signature,
                        count
                    })
            );

    let status = 'CONSISTENT';

    if (lista.length === 0) {
        status = 'EMPTY';
    } else if (invalidas.length > 0) {
        status = 'INVALID';
    } else if (profiles.length > 1) {
        status = 'INCONSISTENT';
    }

    return Object.freeze({
        status,

        total_strategies:
            lista.length,

        profiles:
            Object.freeze(profiles),

        invalid_strategies:
            Object.freeze(invalidas),

        canonical_profile:
            status === 'CONSISTENT'
            && profiles.length === 1
                ? profiles[0].signature
                : null
    });
}

function parseConfigRobo(configJson) {
    let bruto;

    try {
        bruto =
            typeof configJson === 'string'
                ? JSON.parse(
                    configJson || '{}'
                )
                : (configJson || {});
    } catch (_) {
        return Object.freeze({
            ok: false,
            reason:
                'CONFIG_JSON_INVALIDO',
            config: null
        });
    }

    if (
        !bruto
        || typeof bruto !== 'object'
        || Array.isArray(bruto)
    ) {
        return Object.freeze({
            ok: false,
            reason:
                'CONFIG_JSON_NAO_OBJETO',
            config: null
        });
    }

    return Object.freeze({
        ok: true,
        reason: null,

        config:
            Object.freeze({
                ...bruto,

                origens:
                    Object.freeze(
                        normalizarListaStrings(
                            bruto.origens
                        )
                    ),

                avulsos:
                    Object.freeze(
                        normalizarListaStrings(
                            bruto.avulsos
                        )
                    ),

                excecoes:
                    Object.freeze(
                        normalizarListaStrings(
                            bruto.excecoes
                        )
                    )
            })
    });
}

function roboSintonizaEstrategia(
    robo,
    estrategia,
    config
) {
    if (
        Number(robo?.mesa_id)
        !== Number(
            estrategia?.mesa_id
        )
    ) {
        return false;
    }

    if (
        dinamico(
            estrategia?.is_dinamico
        )
    ) {
        return (
            Number(
                estrategia?.robo_dono_id
            )
            === Number(robo?.id)
        );
    }

    const estrategiaId =
        String(
            estrategia?.id ?? ''
        );

    const origem =
        String(
            estrategia?.origem ?? ''
        );

    const excecoes =
        Array.isArray(config?.excecoes)
            ? config.excecoes
            : [];

    const avulsos =
        Array.isArray(config?.avulsos)
            ? config.avulsos
            : [];

    const origens =
        Array.isArray(config?.origens)
            ? config.origens
            : [];

    if (
        excecoes.includes(
            estrategiaId
        )
    ) {
        return false;
    }

    if (
        avulsos.includes(
            estrategiaId
        )
    ) {
        return true;
    }

    return origens.includes(origem);
}

function selecionarEstrategiasDoRobo({
    robo,
    config,
    estrategias
}) {
    return (
        Array.isArray(estrategias)
            ? estrategias
            : []
    ).filter(
        estrategia =>
            roboSintonizaEstrategia(
                robo,
                estrategia,
                config
            )
    );
}

function estrategiasManuaisDaOrigem({
    mesaId,
    origem,
    estrategias
}) {
    const nomeOrigem =
        String(origem ?? '').trim();

    return (
        Array.isArray(estrategias)
            ? estrategias
            : []
    ).filter(
        estrategia =>
            Number(
                estrategia?.mesa_id
            ) === Number(mesaId)
            && !dinamico(
                estrategia?.is_dinamico
            )
            && String(
                estrategia?.origem ?? ''
            ).trim() === nomeOrigem
    );
}

module.exports = {
    VALID_GALES,

    booleanoEstrito,
    dinamico,
    normalizarListaStrings,

    perfilDaEstrategia,
    perfisIguais,
    analisarConjuntoPerfis,

    parseConfigRobo,

    roboSintonizaEstrategia,
    selecionarEstrategiasDoRobo,
    estrategiasManuaisDaOrigem
};
