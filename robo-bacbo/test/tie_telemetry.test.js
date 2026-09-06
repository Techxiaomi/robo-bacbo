'use strict';

const test =
    require('node:test');

const assert =
    require('node:assert/strict');

const {
    normalizarNivelEmpate,
    normalizarProtecaoSnapshot,
    impactoPrincipalTieSemProtecao,
    classificarTieObservado,
    criarTelemetriaEmpatesVazia,
    agregarTieObservado,
    agregarListaTies
} = require('../tie_telemetry');

test(
    'normaliza níveis DIRETO G1 G2 sem ambiguidade',
    () => {
        assert.equal(
            normalizarNivelEmpate('DIRETO'),
            'direto'
        );

        assert.equal(
            normalizarNivelEmpate(0),
            'direto'
        );

        assert.equal(
            normalizarNivelEmpate('GALE1'),
            'gale1'
        );

        assert.equal(
            normalizarNivelEmpate(1),
            'gale1'
        );

        assert.equal(
            normalizarNivelEmpate('G2'),
            'gale2'
        );

        assert.equal(
            normalizarNivelEmpate(2),
            'gale2'
        );

        assert.equal(
            normalizarNivelEmpate('GALE3'),
            null
        );
    }
);

test(
    'snapshot de proteção aceita somente representações conhecidas',
    () => {
        assert.equal(
            normalizarProtecaoSnapshot(true),
            true
        );

        assert.equal(
            normalizarProtecaoSnapshot('1'),
            true
        );

        assert.equal(
            normalizarProtecaoSnapshot(false),
            false
        );

        assert.equal(
            normalizarProtecaoSnapshot('false'),
            false
        );

        assert.equal(
            normalizarProtecaoSnapshot('talvez'),
            null
        );
    }
);

test(
    'resultado que não é Tie não cria observação de empate',
    () => {
        assert.deepEqual(
            classificarTieObservado({
                resultado: 'Player',
                nivel: 'DIRETO',
                proteger_empate_snapshot:
                    false
            }),
            {
                observado: false,
                motivo:
                    'RESULTADO_NAO_TIE'
            }
        );
    }
);

test(
    'Tie protegido é observado e preserva multiplicador real',
    () => {
        const result =
            classificarTieObservado({
                resultado: 'Tie',
                nivel: 'GALE1',
                multiplicador: '25x',
                proteger_empate_snapshot:
                    true,
                valor_principal: 100
            });

        assert.equal(
            result.observado,
            true
        );

        assert.equal(
            result.classificacao,
            'PROTEGIDO'
        );

        assert.equal(
            result.nivel,
            'gale1'
        );

        assert.equal(
            result.multiplicador,
            '25x'
        );

        assert.equal(
            result.impacto_sem_protecao,
            null
        );
    }
);

test(
    'Tie sem proteção continua observado em vez de desaparecer',
    () => {
        const result =
            classificarTieObservado({
                resultado: 'Tie',
                nivel: 'GALE2',
                multiplicador: '6x',
                proteger_empate_snapshot:
                    false
            });

        assert.equal(
            result.observado,
            true
        );

        assert.equal(
            result.classificacao,
            'SEM_PROTECAO'
        );

        assert.equal(
            result.nivel,
            'gale2'
        );

        assert.equal(
            result.multiplicador,
            '6x'
        );
    }
);

test(
    'Tie sem proteção calcula retorno 90 e retenção 10 quando há base confiável',
    () => {
        assert.deepEqual(
            impactoPrincipalTieSemProtecao(
                100
            ),
            {
                conhecido: true,
                regra:
                    'RETORNO_90_RETENCAO_10',
                percentual_retorno: 90,
                percentual_retencao: 10,
                base_principal: 100,
                valor_retornado: 90,
                valor_retido: 10,
                pnl_principal: -10
            }
        );
    }
);

test(
    'impacto sem proteção não inventa valor quando base principal não existe',
    () => {
        const impacto =
            impactoPrincipalTieSemProtecao(
                null
            );

        assert.equal(
            impacto.conhecido,
            false
        );

        assert.equal(
            impacto.base_principal,
            null
        );

        assert.equal(
            impacto.valor_retido,
            null
        );
    }
);

test(
    'proteção desconhecida preserva TIE observado sem inferir classificação histórica',
    () => {
        const result =
            classificarTieObservado({
                resultado: 'Tie',
                nivel: 'DIRETO',
                multiplicador: '4x'
            });

        assert.equal(
            result.observado,
            true
        );

        assert.equal(
            result.classificacao,
            'PROTECAO_DESCONHECIDA'
        );

        assert.equal(
            result.proteger_empate_snapshot,
            null
        );
    }
);

test(
    'agregador separa observado protegido sem proteção e desconhecido',
    () => {
        const stats =
            agregarListaTies([
                {
                    resultado: 'Tie',
                    nivel: 'DIRETO',
                    multiplicador: '4x',
                    proteger_empate_snapshot:
                        true
                },
                {
                    resultado: 'Tie',
                    nivel: 'GALE1',
                    multiplicador: '6x',
                    proteger_empate_snapshot:
                        false,
                    valor_principal: 200
                },
                {
                    resultado: 'Tie',
                    nivel: 'GALE2',
                    multiplicador: '25x',
                    proteger_empate_snapshot:
                        null
                }
            ]);

        assert.deepEqual(
            stats.observados,
            {
                total: 3,
                direto: 1,
                gale1: 1,
                gale2: 1
            }
        );

        assert.deepEqual(
            {
                total:
                    stats.protegidos.total,
                direto:
                    stats.protegidos.direto,
                gale1:
                    stats.protegidos.gale1,
                gale2:
                    stats.protegidos.gale2
            },
            {
                total: 1,
                direto: 1,
                gale1: 0,
                gale2: 0
            }
        );

        assert.equal(
            stats
                .protegidos
                .multiplicadores
                .direto['4x'],
            1
        );

        assert.deepEqual(
            stats.sem_protecao,
            {
                total: 1,
                direto: 0,
                gale1: 1,
                gale2: 0
            }
        );

        assert.deepEqual(
            stats.protecao_desconhecida,
            {
                total: 1,
                direto: 0,
                gale1: 0,
                gale2: 1
            }
        );

        assert.deepEqual(
            stats.impacto_sem_protecao,
            {
                eventos_com_base: 1,
                eventos_sem_base: 0,
                base_principal_total: 200,
                valor_retornado_total: 180,
                valor_retido_total: 20,
                pnl_principal_total: -20
            }
        );
    }
);

test(
    'agregador conta empate sem proteção mesmo sem base financeira',
    () => {
        const stats =
            criarTelemetriaEmpatesVazia();

        agregarTieObservado(
            stats,
            {
                resultado: 'Tie',
                nivel: 0,
                multiplicador: '10x',
                proteger_empate_snapshot:
                    false
            }
        );

        assert.equal(
            stats.observados.total,
            1
        );

        assert.equal(
            stats.sem_protecao.total,
            1
        );

        assert.equal(
            stats.impacto_sem_protecao
                .eventos_sem_base,
            1
        );

        assert.equal(
            stats.protegidos.total,
            0
        );
    }
);
