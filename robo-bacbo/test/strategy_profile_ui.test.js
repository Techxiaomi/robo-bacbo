'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root =
    path.join(__dirname, '..');

const source =
    fs.readFileSync(
        path.join(
            root,
            'public',
            'strategy-profile-ui.js'
        ),
        'utf8'
    );

const index =
    fs.readFileSync(
        path.join(
            root,
            'public',
            'index.html'
        ),
        'utf8'
    );

function carregarModulo() {
    const sandbox = {
        window: {},
        document: {},
        console
    };

    vm.runInNewContext(
        source,
        sandbox,
        {
            filename:
                'strategy-profile-ui.js'
        }
    );

    return sandbox.window;
}

test('publica readiness e API da UI estrutural', () => {
    const window =
        carregarModulo();

    assert.equal(
        window.__strategyProfileUiReady,
        true
    );

    assert.equal(
        typeof window
            .__strategyProfileUi
            .install,
        'function'
    );
});

test('normaliza G2 sem proteção', () => {
    const window =
        carregarModulo();

    const perfil =
        window
            .__strategyProfileUi
            .perfilDaEstrategia({
                gales: 2,
                proteger_empate: false
            });

    assert.equal(
        perfil.signature,
        'G2_SEM_EMPATE'
    );

    assert.equal(
        window
            .__strategyProfileUi
            .textoPerfil(perfil),
        'G2 • SEM PROTEÇÃO DE EMPATE'
    );
});

test('normaliza G1 com proteção', () => {
    const window =
        carregarModulo();

    const perfil =
        window
            .__strategyProfileUi
            .perfilDaEstrategia({
                gales: '1',
                proteger_empate: 1
            });

    assert.equal(
        perfil.signature,
        'G1_COM_EMPATE'
    );
});

test('409 de estratégia apresenta esperado e recebido', () => {
    const window =
        carregarModulo();

    const msg =
        window
            .__strategyProfileUi
            .mensagem409({
                erro:
                    'ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM',

                perfil_esperado:
                    'G2_COM_EMPATE',

                perfil_recebido:
                    'G1_COM_EMPATE'
            });

    assert.match(
        msg,
        /G2_COM_EMPATE/
    );

    assert.match(
        msg,
        /G1_COM_EMPATE/
    );
});

test('409 de robô apresenta perfis conflitantes', () => {
    const window =
        carregarModulo();

    const msg =
        window
            .__strategyProfileUi
            .mensagem409({
                erro:
                    'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL',

                perfis_encontrados: [
                    {
                        signature:
                            'G1_COM_EMPATE'
                    },
                    {
                        signature:
                            'G2_COM_EMPATE'
                    }
                ]
            });

    assert.match(
        msg,
        /G1_COM_EMPATE/
    );

    assert.match(
        msg,
        /G2_COM_EMPATE/
    );
});

test('bootstrap carrega controlador exatamente uma vez', () => {
    assert.equal(
        (
            index.match(
                /\/strategy-profile-ui\.js/g
            )
            || []
        ).length,
        1
    );

    assert.equal(
        (
            index.match(
                /__strategyProfileUiReady/g
            )
            || []
        ).length,
        1
    );

    assert.equal(
        (
            index.match(
                /__strategyProfileUi\.install\(\)/g
            )
            || []
        ).length,
        1
    );
});

test('instala controlador depois do script principal', () => {
    const append =
        index.indexOf(
            'document.body.appendChild(script);'
        );

    const install =
        index.indexOf(
            '__strategyProfileUi.install()'
        );

    assert.ok(append >= 0);
    assert.ok(install > append);
});

test('UI possui herança e travamento de estratégia', () => {
    assert.match(
        source,
        /gales\.disabled = trava/
    );

    assert.match(
        source,
        /empate\.disabled = trava/
    );

    assert.match(
        source,
        /perfilDaOrigem/
    );
});

test('UI cobre origens avulsos exceções e IA do robô', () => {
    assert.match(
        source,
        /chk-robo-origem/
    );

    assert.match(
        source,
        /chk-robo-avulso/
    );

    assert.match(
        source,
        /chk-robo-excecao/
    );

    assert.match(
        source,
        /robo-ia-gales/
    );

    assert.match(
        source,
        /robo-ia-prot/
    );
});

test('UI trata explicitamente HTTP 409', () => {
    assert.match(
        source,
        /res\.status === 409/
    );

    assert.match(
        source,
        /ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM/
    );

    assert.match(
        source,
        /ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL/
    );
});

test('UI cadastral não contém integração financeira', () => {
    assert.doesNotMatch(
        source,
        /auditoria_ordens|place_bet|redis_executor|saldo_atual|stake_principal/i
    );
});


test('salvar robô trata 409 diretamente sem monkey-patch de fetch', () => {
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
        /window\.salvarRobo\s*=\s*[\s\S]*?async\s+function/
    );

    assert.match(
        source,
        /res\.status\s*===\s*409[\s\S]*?mensagem409/
    );
});

test('save estrutural continua usando payload canônico do formulário do robô', () => {
    assert.match(
        source,
        /construirPayloadRobo\s*\(/
    );

    assert.match(
        source,
        /signaturesRobo\s*\(\)[\s\S]*?length\s*>\s*1/
    );
});

test('configuração IA ativa participa da assinatura visual do robô', () => {
    assert.match(
        source,
        /function\s+perfilIaConfigurado\s*\(/
    );

    assert.match(
        source,
        /!ativo\?\.checked/
    );

    assert.match(
        source,
        /perfis\.push\(ia\)/
    );
});
