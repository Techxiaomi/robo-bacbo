'use strict';

const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(
    path.join(__dirname, '..', '..', '.env')
);

const {
    dinamico,
    perfilDaEstrategia,
    analisarConjuntoPerfis,
    parseConfigRobo,
    roboSintonizaEstrategia
} = require('../strategy_profile_policy');

function chaveMesaOrigem(
    mesaId,
    origem
) {
    return (
        `${Number(mesaId)}\u0000`
        + `${String(origem ?? '')}`
    );
}

function auditarEstruturas({
    origens = [],
    estrategias = [],
    robos = []
} = {}) {
    const issues = [];

    const origemPorChave =
        new Map();

    const origensPorNome =
        new Map();

    for (const origem of origens) {
        const nome =
            String(
                origem?.nome ?? ''
            ).trim();

        const mesaId =
            Number(
                origem?.mesa_id
            );

        const chave =
            chaveMesaOrigem(
                mesaId,
                nome
            );

        if (
            !origensPorNome.has(chave)
        ) {
            origensPorNome.set(
                chave,
                []
            );
        }

        origensPorNome
            .get(chave)
            .push(origem);

        if (
            !origemPorChave.has(chave)
        ) {
            origemPorChave.set(
                chave,
                origem
            );
        }
    }

    for (
        const [chave, itens]
        of origensPorNome.entries()
    ) {
        if (itens.length <= 1) {
            continue;
        }

        const [mesaTexto, nome] =
            chave.split('\u0000');

        issues.push({
            severity: 'ERROR',
            code:
                'ORIGEM_DUPLICADA_NA_MESA',

            mesa_id:
                Number(mesaTexto),

            origem:
                nome,

            count:
                itens.length,

            ids:
                itens.map(
                    item =>
                        Number(item.id)
                )
        });
    }

    const estrategiasManuais =
        estrategias.filter(
            estrategia =>
                !dinamico(
                    estrategia?.is_dinamico
                )
        );

    for (
        const estrategia
        of estrategiasManuais
    ) {
        const nomeOrigem =
            String(
                estrategia?.origem ?? ''
            ).trim();

        if (!nomeOrigem) {
            issues.push({
                severity: 'ERROR',

                code:
                    'ESTRATEGIA_MANUAL_SEM_ORIGEM',

                mesa_id:
                    Number(
                        estrategia?.mesa_id
                    ),

                estrategia_id:
                    String(
                        estrategia?.id ?? ''
                    ),

                estrategia_nome:
                    String(
                        estrategia?.nome ?? ''
                    )
            });

            continue;
        }

        const chave =
            chaveMesaOrigem(
                estrategia?.mesa_id,
                nomeOrigem
            );

        if (
            !origemPorChave.has(chave)
        ) {
            issues.push({
                severity: 'ERROR',

                code:
                    'ORIGEM_REFERENCIADA_NAO_CADASTRADA',

                mesa_id:
                    Number(
                        estrategia?.mesa_id
                    ),

                origem:
                    nomeOrigem,

                estrategia_id:
                    String(
                        estrategia?.id ?? ''
                    ),

                estrategia_nome:
                    String(
                        estrategia?.nome ?? ''
                    )
            });
        }
    }

    const originReports =
        origens.map(origem => {
            const nome =
                String(
                    origem?.nome ?? ''
                ).trim();

            const mesaId =
                Number(
                    origem?.mesa_id
                );

            const estrategiasDaOrigem =
                estrategiasManuais.filter(
                    estrategia =>
                        Number(
                            estrategia?.mesa_id
                        ) === mesaId
                        && String(
                            estrategia?.origem ?? ''
                        ).trim() === nome
                );

            const profileAudit =
                analisarConjuntoPerfis(
                    estrategiasDaOrigem
                );

            if (
                profileAudit.status
                    === 'INCONSISTENT'
                || profileAudit.status
                    === 'INVALID'
            ) {
                issues.push({
                    severity: 'ERROR',

                    code:
                        profileAudit.status
                            === 'INCONSISTENT'
                            ? 'ORIGEM_PERFIL_MISTO'
                            : 'ORIGEM_PERFIL_INVALIDO',

                    mesa_id:
                        mesaId,

                    origem_id:
                        Number(origem?.id),

                    origem:
                        nome,

                    profiles:
                        profileAudit.profiles,

                    invalid_strategies:
                        profileAudit
                            .invalid_strategies
                });
            }

            return Object.freeze({
                id:
                    Number(origem?.id),

                mesa_id:
                    mesaId,

                nome,

                ...profileAudit
            });
        });

    const idsEstrategias =
        new Set(
            estrategias.map(
                estrategia =>
                    String(
                        estrategia?.id ?? ''
                    )
            )
        );

    const robotReports =
        robos.map(robo => {
            const parsedConfig =
                parseConfigRobo(
                    robo?.config_json
                );

            if (!parsedConfig.ok) {
                issues.push({
                    severity: 'ERROR',

                    code:
                        'ROBO_CONFIG_JSON_INVALIDO',

                    mesa_id:
                        Number(
                            robo?.mesa_id
                        ),

                    robo_id:
                        Number(
                            robo?.id
                        ),

                    robo_nome:
                        String(
                            robo?.nome ?? ''
                        ),

                    reason:
                        parsedConfig.reason
                });

                return Object.freeze({
                    id:
                        Number(robo?.id),

                    mesa_id:
                        Number(
                            robo?.mesa_id
                        ),

                    nome:
                        String(
                            robo?.nome ?? ''
                        ),

                    ativo:
                        false,

                    config_ok:
                        false,

                    status:
                        'INVALID',

                    total_strategies:
                        0,

                    profiles:
                        Object.freeze([]),

                    invalid_strategies:
                        Object.freeze([]),

                    canonical_profile:
                        null,

                    refs:
                        Object.freeze({
                            origens:
                                Object.freeze([]),

                            avulsos:
                                Object.freeze([]),

                            excecoes:
                                Object.freeze([])
                        })
                });
            }

            const config =
                parsedConfig.config;

            for (
                const origemNome
                of config.origens
            ) {
                const chave =
                    chaveMesaOrigem(
                        robo?.mesa_id,
                        origemNome
                    );

                if (
                    !origemPorChave
                        .has(chave)
                ) {
                    issues.push({
                        severity: 'WARN',

                        code:
                            'ROBO_ORIGEM_REFERENCIADA_INEXISTENTE',

                        mesa_id:
                            Number(
                                robo?.mesa_id
                            ),

                        robo_id:
                            Number(
                                robo?.id
                            ),

                        robo_nome:
                            String(
                                robo?.nome ?? ''
                            ),

                        origem:
                            origemNome
                    });
                }
            }

            for (
                const estrategiaId
                of [
                    ...config.avulsos,
                    ...config.excecoes
                ]
            ) {
                if (
                    !idsEstrategias
                        .has(estrategiaId)
                ) {
                    issues.push({
                        severity: 'WARN',

                        code:
                            'ROBO_ESTRATEGIA_REFERENCIADA_INEXISTENTE',

                        mesa_id:
                            Number(
                                robo?.mesa_id
                            ),

                        robo_id:
                            Number(
                                robo?.id
                            ),

                        robo_nome:
                            String(
                                robo?.nome ?? ''
                            ),

                        estrategia_id:
                            estrategiaId
                    });
                }
            }

            const selecionadas =
                estrategias.filter(
                    estrategia =>
                        roboSintonizaEstrategia(
                            robo,
                            estrategia,
                            config
                        )
                );

            const profileAudit =
                analisarConjuntoPerfis(
                    selecionadas
                );

            if (
                profileAudit.status
                    === 'INCONSISTENT'
                || profileAudit.status
                    === 'INVALID'
            ) {
                issues.push({
                    severity: 'ERROR',

                    code:
                        profileAudit.status
                            === 'INCONSISTENT'
                            ? 'ROBO_PERFIL_MISTO'
                            : 'ROBO_PERFIL_INVALIDO',

                    mesa_id:
                        Number(
                            robo?.mesa_id
                        ),

                    robo_id:
                        Number(
                            robo?.id
                        ),

                    robo_nome:
                        String(
                            robo?.nome ?? ''
                        ),

                    profiles:
                        profileAudit.profiles,

                    invalid_strategies:
                        profileAudit
                            .invalid_strategies
                });
            }

            return Object.freeze({
                id:
                    Number(robo?.id),

                mesa_id:
                    Number(
                        robo?.mesa_id
                    ),

                nome:
                    String(
                        robo?.nome ?? ''
                    ),

                ativo:
                    Boolean(robo?.ativo),

                config_ok:
                    true,

                ...profileAudit,

                refs:
                    Object.freeze({
                        origens:
                            config.origens,

                        avulsos:
                            config.avulsos,

                        excecoes:
                            config.excecoes
                    }),

                strategies:
                    Object.freeze(
                        selecionadas.map(
                            estrategia =>
                                Object.freeze({
                                    id:
                                        String(
                                            estrategia?.id ?? ''
                                        ),

                                    nome:
                                        String(
                                            estrategia?.nome ?? ''
                                        ),

                                    origem:
                                        String(
                                            estrategia?.origem ?? ''
                                        ),

                                    is_dinamico:
                                        dinamico(
                                            estrategia?.is_dinamico
                                        ),

                                    robo_dono_id:
                                        estrategia?.robo_dono_id
                                            == null
                                            ? null
                                            : Number(
                                                estrategia
                                                    .robo_dono_id
                                            ),

                                    profile:
                                        perfilDaEstrategia(
                                            estrategia
                                        )
                                })
                        )
                    )
            });
        });

    const mesas =
        new Set([
            ...origens.map(
                item =>
                    Number(
                        item?.mesa_id
                    )
            ),

            ...estrategias.map(
                item =>
                    Number(
                        item?.mesa_id
                    )
            ),

            ...robos.map(
                item =>
                    Number(
                        item?.mesa_id
                    )
            )
        ]);

    const errorCount =
        issues.filter(
            item =>
                item.severity === 'ERROR'
        ).length;

    const warningCount =
        issues.filter(
            item =>
                item.severity === 'WARN'
        ).length;

    return Object.freeze({
        generated_at:
            new Date().toISOString(),

        read_only: true,

        ok:
            errorCount === 0,

        summary:
            Object.freeze({
                mesas:
                    [...mesas]
                        .filter(
                            Number.isFinite
                        )
                        .length,

                origens:
                    originReports.length,

                origens_consistentes:
                    originReports.filter(
                        item =>
                            item.status
                                === 'CONSISTENT'
                    ).length,

                origens_inconsistentes:
                    originReports.filter(
                        item =>
                            item.status
                                === 'INCONSISTENT'
                    ).length,

                origens_invalidas:
                    originReports.filter(
                        item =>
                            item.status
                                === 'INVALID'
                    ).length,

                origens_vazias:
                    originReports.filter(
                        item =>
                            item.status
                                === 'EMPTY'
                    ).length,

                robos:
                    robotReports.length,

                robos_consistentes:
                    robotReports.filter(
                        item =>
                            item.status
                                === 'CONSISTENT'
                    ).length,

                robos_inconsistentes:
                    robotReports.filter(
                        item =>
                            item.status
                                === 'INCONSISTENT'
                    ).length,

                robos_invalidos:
                    robotReports.filter(
                        item =>
                            item.status
                                === 'INVALID'
                    ).length,

                robos_vazios:
                    robotReports.filter(
                        item =>
                            item.status
                                === 'EMPTY'
                    ).length,

                errors:
                    errorCount,

                warnings:
                    warningCount
            }),

        origins:
            Object.freeze(
                originReports
            ),

        robots:
            Object.freeze(
                robotReports
            ),

        issues:
            Object.freeze(
                issues.map(
                    item =>
                        Object.freeze(
                            item
                        )
                )
            )
    });
}

function criarPool() {
    return mysql.createPool({
        host:
            process.env.DB_HOST,

        port:
            Number(
                process.env.DB_PORT
                || 3306
            ),

        user:
            process.env.DB_USER,

        password:
            process.env.DB_PASSWORD,

        database:
            process.env.DB_NAME,

        waitForConnections:
            true,

        connectionLimit:
            2,

        queueLimit:
            0
    });
}

async function lerSnapshotAuditoria(
    dbPool
) {
    const [origens] =
        await dbPool.query(
            `SELECT
                id,
                mesa_id,
                nome
             FROM origens
             ORDER BY mesa_id, id`
        );

    const [estrategias] =
        await dbPool.query(
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
             ORDER BY mesa_id, origem, id`
        );

    const [robos] =
        await dbPool.query(
            `SELECT
                id,
                mesa_id,
                nome,
                ativo,
                config_json
             FROM robos_canais
             ORDER BY mesa_id, id`
        );

    return Object.freeze({
        origens,
        estrategias,
        robos
    });
}

function formatarProfiles(
    profiles
) {
    if (
        !Array.isArray(profiles)
        || profiles.length === 0
    ) {
        return '-';
    }

    return profiles
        .map(
            item =>
                `${item.signature}:${item.count}`
        )
        .join(', ');
}

function imprimirRelatorio(
    report
) {
    console.log('');
    console.log(
        '============================================================'
    );
    console.log(
        ' AUDITORIA READ-ONLY DE PERFIS ESTRUTURAIS'
    );
    console.log(
        '============================================================'
    );

    console.log(
        `READ_ONLY=${report.read_only}`
    );

    console.log(
        `OK=${report.ok}`
    );

    console.log(
        `MESAS=${report.summary.mesas}`
    );

    console.log('');
    console.log('--- ORIGENS ---');

    for (
        const origem
        of report.origins
    ) {
        console.log(
            `[${origem.status}] `
            + `mesa=${origem.mesa_id} `
            + `origem_id=${origem.id} `
            + `nome=${JSON.stringify(origem.nome)} `
            + `padroes=${origem.total_strategies} `
            + `perfil=${origem.canonical_profile || '-'} `
            + `perfis=[${formatarProfiles(origem.profiles)}]`
        );
    }

    console.log('');
    console.log('--- ROBOS ---');

    for (
        const robo
        of report.robots
    ) {
        console.log(
            `[${robo.status}] `
            + `mesa=${robo.mesa_id} `
            + `robo_id=${robo.id} `
            + `nome=${JSON.stringify(robo.nome)} `
            + `padroes=${robo.total_strategies} `
            + `perfil=${robo.canonical_profile || '-'} `
            + `perfis=[${formatarProfiles(robo.profiles)}]`
        );
    }

    console.log('');
    console.log('--- ISSUES ---');

    if (
        report.issues.length === 0
    ) {
        console.log(
            'Nenhuma inconsistência encontrada.'
        );
    } else {
        for (
            const issue
            of report.issues
        ) {
            console.log(
                `[${issue.severity}] `
                + `${issue.code} `
                + JSON.stringify(issue)
            );
        }
    }

    console.log('');
    console.log('--- RESUMO ---');

    for (
        const [key, value]
        of Object.entries(
            report.summary
        )
    ) {
        console.log(
            `${key.toUpperCase()}=${value}`
        );
    }

    console.log(
        '============================================================'
    );
}

async function main() {
    const jsonOnly =
        process.argv.includes(
            '--json'
        );

    const strict =
        process.argv.includes(
            '--strict'
        );

    const dbPool =
        criarPool();

    try {
        const snapshot =
            await lerSnapshotAuditoria(
                dbPool
            );

        const report =
            auditarEstruturas(
                snapshot
            );

        if (jsonOnly) {
            console.log(
                JSON.stringify(
                    report,
                    null,
                    2
                )
            );
        } else {
            imprimirRelatorio(
                report
            );
        }

        if (
            strict
            && report.ok !== true
        ) {
            process.exitCode = 2;
        }
    } finally {
        await dbPool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(
            'STRATEGY_PROFILE_AUDIT_FAILED:',
            error?.message || error
        );

        process.exitCode = 1;
    });
}

module.exports = {
    chaveMesaOrigem,
    auditarEstruturas,
    lerSnapshotAuditoria,
    formatarProfiles
};
