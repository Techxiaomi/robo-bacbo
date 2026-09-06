'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiPath =
    path.join(
        __dirname,
        '..',
        'public',
        'strategy-profile-ui.js'
    );

const source =
    fs.readFileSync(
        uiPath,
        'utf8'
    );

function carregarUi(
    estrategias = []
) {
    const window = {};

    const sandbox = {
        window,

        document: {
            getElementById() {
                return null;
            },

            querySelectorAll() {
                return [];
            },

            createElement() {
                return {
                    dataset: {},
                    style: {},
                    classList: {
                        add() {},
                        remove() {}
                    }
                };
            }
        },

        estrategiasGlobais:
            estrategias,

        robosGlobais: [],

        console,

        Object,
        Array,
        String,
        Number,
        Boolean,
        Set,
        Map,
        JSON,
        RegExp
    };

    vm.createContext(sandbox);

    vm.runInContext(
        source,
        sandbox,
        {
            filename:
                'strategy-profile-ui.js'
        }
    );

    assert.equal(
        window.__strategyProfileUiReady,
        true
    );

    assert.ok(
        window.__strategyProfileUi
    );

    return {
        window,
        api:
            window.__strategyProfileUi
    };
}

function padroesDaOrigem({
    origem,
    quantidade,
    gales,
    proteger_empate,
    inicio = 1
}) {
    return Array.from(
        {
            length:
                quantidade
        },

        (_, index) => ({
            id:
                String(
                    inicio + index
                ),

            origem,

            gales,

            proteger_empate,

            is_dinamico:
                false
        })
    );
}

/*
 * CENÁRIO 1
 * Neurobet = G2_COM_EMPATE.
 *
 * Não depende de uma "tela de origem":
 * testa a mesma função usada pela UI para
 * calcular o perfil do select de origem.
 */
test(
    'AUTO-UI-01 Neurobet é reconhecida como G2_COM_EMPATE',
    () => {
        const estrategias =
            padroesDaOrigem({
                origem:
                    'Neurobet',

                quantidade:
                    11,

                gales:
                    2,

                proteger_empate:
                    true
            });

        const {
            api
        } =
            carregarUi(
                estrategias
            );

        const result =
            api.perfilDaOrigem(
                'Neurobet'
            );

        assert.equal(
            result.status,
            'CONSISTENT'
        );

        assert.equal(
            result.total,
            11
        );

        assert.equal(
            result.perfil.signature,
            'G2_COM_EMPATE'
        );

        assert.equal(
            result.perfil.gales,
            2
        );

        assert.equal(
            result.perfil
                .proteger_empate,
            true
        );
    }
);

/*
 * CENÁRIO 2
 * Backtest G1 = G1_COM_EMPATE.
 */
test(
    'AUTO-UI-02 Backtest G1 é reconhecida como G1_COM_EMPATE',
    () => {
        const estrategias =
            padroesDaOrigem({
                origem:
                    'Backtest G1',

                quantidade:
                    14,

                gales:
                    1,

                proteger_empate:
                    true
            });

        const {
            api
        } =
            carregarUi(
                estrategias
            );

        const result =
            api.perfilDaOrigem(
                'Backtest G1'
            );

        assert.equal(
            result.status,
            'CONSISTENT'
        );

        assert.equal(
            result.total,
            14
        );

        assert.equal(
            result.perfil.signature,
            'G1_COM_EMPATE'
        );
    }
);

/*
 * CENÁRIO 3
 * Bacbo Club sem padrões permanece EMPTY.
 * O primeiro padrão poderá definir o perfil.
 */
test(
    'AUTO-UI-03 origem vazia permanece EMPTY e sem perfil',
    () => {
        const {
            api
        } =
            carregarUi([]);

        const result =
            api.perfilDaOrigem(
                'Bacbo Club'
            );

        assert.equal(
            result.status,
            'EMPTY'
        );

        assert.equal(
            result.perfil,
            null
        );

        assert.equal(
            result.total,
            0
        );

        assert.match(
            source,
            /resultado\.status\s*===\s*'EMPTY'/
        );

        assert.match(
            source,
            /Origem sem padrões:/
        );

        assert.match(
            source,
            /o primeiro padrão definirá o perfil estrutural/
        );
    }
);

/*
 * CENÁRIO 4
 * Origem consistente deve herdar/travar
 * Gales + Proteção no formulário.
 */
test(
    'AUTO-UI-04 perfil consistente da origem força herança estrutural',
    () => {
        assert.match(
            source,
            /const\s+trava\s*=\s*[\s\S]*?resultado\.status\s*===\s*'CONSISTENT'[\s\S]*?&&\s*!unicoPadraoAtual/
        );

        assert.match(
            source,
            /if\s*\(trava\)[\s\S]*?gales\.value\s*=[\s\S]*?resultado\.perfil\.gales/
        );

        assert.match(
            source,
            /if\s*\(trava\)[\s\S]*?empate\.checked\s*=[\s\S]*?proteger_empate/
        );

        assert.match(
            source,
            /gales\.disabled\s*=\s*trava/
        );

        assert.match(
            source,
            /empate\.disabled\s*=\s*trava/
        );
    }
);

/*
 * CENÁRIO 5
 * G2 Sem Empate preserva assinatura correta.
 */
test(
    'AUTO-UI-05 G2 Sem Empate permanece G2_SEM_EMPATE',
    () => {
        const {
            api
        } =
            carregarUi();

        const perfil =
            api.perfilDaEstrategia({
                gales:
                    2,

                proteger_empate:
                    false
            });

        assert.ok(
            perfil
        );

        assert.equal(
            perfil.signature,
            'G2_SEM_EMPATE'
        );

        assert.equal(
            perfil.gales,
            2
        );

        assert.equal(
            perfil
                .proteger_empate,
            false
        );
    }
);

/*
 * CENÁRIO 5B
 * IA ativa herda exatamente o perfil-base
 * do robô e bloqueia edição divergente.
 */
test(
    'AUTO-UI-06 IA herda Gales e proteção do perfil-base do robô',
    () => {
        assert.match(
            source,
            /function\s+sincronizarIa\s*\(/
        );

        assert.match(
            source,
            /const\s+base\s*=\s*[\s\S]*?perfilBaseRoboSemConfigIa\s*\(\)/
        );

        assert.match(
            source,
            /gales\.value\s*=\s*[\s\S]*?String\(base\.gales\)/
        );

        assert.match(
            source,
            /empate\.checked\s*=\s*[\s\S]*?base\.proteger_empate/
        );

        assert.match(
            source,
            /gales\.disabled\s*=\s*[\s\S]*?deveHerdar/
        );

        assert.match(
            source,
            /empate\.disabled\s*=\s*[\s\S]*?deveHerdar/
        );

        assert.match(
            source,
            /function\s+atualizarRobo\s*\(\)\s*\{[\s\S]*?sincronizarIa\s*\(\)/
        );
    }
);

/*
 * CENÁRIO 6A
 * Mistura estrutural é detectável.
 */
test(
    'AUTO-UI-07 mistura G2 e G1 produz origem estruturalmente inconsistente',
    () => {
        const estrategias = [
            ...padroesDaOrigem({
                origem:
                    'Misturada',

                quantidade:
                    1,

                gales:
                    2,

                proteger_empate:
                    true
            }),

            ...padroesDaOrigem({
                origem:
                    'Misturada',

                quantidade:
                    1,

                gales:
                    1,

                proteger_empate:
                    true,

                inicio:
                    100
            })
        ];

        const {
            api
        } =
            carregarUi(
                estrategias
            );

        const result =
            api.perfilDaOrigem(
                'Misturada'
            );

        assert.equal(
            result.status,
            'INCONSISTENT'
        );

        assert.equal(
            result.perfil,
            null
        );

        assert.equal(
            result.total,
            2
        );
    }
);

/*
 * CENÁRIO 6B
 * Robô com mais de uma assinatura é
 * bloqueado antes do POST/PUT.
 */
test(
    'AUTO-UI-08 save do robô bloqueia múltiplas assinaturas antes da API',
    () => {
        assert.match(
            source,
            /signaturesRobo\s*\(\)[\s\S]*?\.length\s*>\s*1/
        );

        assert.match(
            source,
            /Não é possível salvar:[\s\S]*?perfis estruturais diferentes/
        );

        const checkPos =
            source.indexOf(
                'signaturesRobo()'
            );

        const fetchPos =
            source.indexOf(
                'await fetch(',
                checkPos
            );

        assert.ok(
            checkPos >= 0,
            'guard estrutural não encontrado'
        );

        assert.ok(
            fetchPos > checkPos,
            'fetch deve ocorrer depois do guard estrutural'
        );
    }
);

/*
 * CENÁRIO 6C
 * Backend 409 gera a mensagem específica
 * de perfis conflitantes.
 */
test(
    'AUTO-UI-09 409 do robô vira mensagem estrutural específica',
    () => {
        const {
            api
        } =
            carregarUi();

        const message =
            api.mensagem409({
                erro:
                    'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL',

                perfis_encontrados: [
                    {
                        signature:
                            'G2_COM_EMPATE'
                    },

                    {
                        signature:
                            'G1_COM_EMPATE'
                    }
                ]
            });

        assert.match(
            message,
            /G2_COM_EMPATE/
        );

        assert.match(
            message,
            /G1_COM_EMPATE/
        );

        assert.doesNotMatch(
            message,
            /^Erro ao salvar o robô\.$/
        );
    }
);

/*
 * CENÁRIO 6D
 * Não pode voltar o monkey-patch de fetch.
 */
test(
    'AUTO-UI-10 salvarRobo trata 409 sem monkey-patch de window.fetch',
    () => {
        assert.doesNotMatch(
            source,
            /const\s+originalSalvar\s*=/
        );

        assert.doesNotMatch(
            source,
            /window\.fetch\s*=/
        );

        assert.match(
            source,
            /res\.status\s*===\s*409[\s\S]*?mensagem409/
        );
    }
);

/*
 * Segurança de escopo:
 * essa UI cadastral não deve conhecer
 * o runtime financeiro.
 */
test(
    'AUTO-UI-11 teste comportamental continua isolado do runtime financeiro',
    () => {
        assert.doesNotMatch(
            source,
            /place_bet|redis_executor|stake_principal|saldo_atual|auditoria_ordens/
        );
    }
);
