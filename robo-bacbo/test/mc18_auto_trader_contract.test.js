'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    validarConfiguracaoAutoTrader
} = require('../bug051d_config_validation');

function configValida(overrides = {}) {
    return {
        stake_inicial: 5,
        gale_1_mult: 2,
        gale_2_mult: 4,

        tie_stake_mode: 'PERCENTUAL',
        tie_stake_percent: 5,
        tie_stake_value: 0,

        gatilho_reds_virtuais: 0,
        sinais_por_onda: 0,
        tipo_aleatoriedade: 'NENHUMA',
        pulo_min: 1,
        pulo_max: 3,
        chance_entrada_pct: 100,
        limite_ciclos: 0,

        limite_entradas: 15,

        stop_win: 100,
        trailing_stop: true,
        trailing_recuo: 0,
        stop_loss: 250,

        stop_reds_seguidos: 0,
        stop_reds_acao: 'PAUSAR',
        stop_reds_pausa_min: 60,

        faixas_horario: [
            {
                inicio: '00:00',
                fim: '23:59'
            }
        ],

        fontes_sinal: [
            'ROBO:1'
        ],

        ...overrides
    };
}

test(
    'MC18: trailing ativo com recuo zero é válido e representa estado não armado',
    () => {
        const validacao =
            validarConfiguracaoAutoTrader(
                configValida({
                    trailing_stop: true,
                    trailing_recuo: 0
                })
            );

        assert.equal(
            validacao.ok,
            true,
            validacao.motivo ||
            'configuração deveria ser válida'
        );
    }
);

test(
    'MC18: trailing ativo com recuo positivo continua válido',
    () => {
        const validacao =
            validarConfiguracaoAutoTrader(
                configValida({
                    trailing_stop: true,
                    trailing_recuo: 10
                })
            );

        assert.equal(
            validacao.ok,
            true,
            validacao.motivo ||
            'configuração deveria ser válida'
        );
    }
);

test(
    'MC18: trailing desligado com recuo zero continua válido',
    () => {
        const validacao =
            validarConfiguracaoAutoTrader(
                configValida({
                    trailing_stop: false,
                    trailing_recuo: 0
                })
            );

        assert.equal(
            validacao.ok,
            true,
            validacao.motivo ||
            'configuração deveria ser válida'
        );
    }
);

test(
    'MC18: recuo negativo continua fail-closed',
    () => {
        const validacao =
            validarConfiguracaoAutoTrader(
                configValida({
                    trailing_stop: true,
                    trailing_recuo: -5
                })
            );

        assert.equal(
            validacao.ok,
            false
        );

        assert.equal(
            validacao.campo,
            'trailing_recuo'
        );
    }
);

test(
    'MC18: formulário atualiza robôs ao abrir e editar sem depender de Ctrl+F5',
    () => {
        const dashboard =
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'public',
                    'dashboard-app.html'
                ),
                'utf8'
            );

        assert.match(
            dashboard,
            /async function atualizarFontesAutoTrader\(fontesAtivas = \[\]\)/
        );

        assert.match(
            dashboard,
            /fetch\(\s*'\/api\/robos\?_t=' \+ Date\.now\(\),\s*\{ cache: 'no-store' \}\s*\)/
        );

        assert.match(
            dashboard,
            /async function abrirFormularioAutoTrader\(\)/
        );

        assert.match(
            dashboard,
            /await atualizarFontesAutoTrader\(\[\]\)/
        );

        assert.match(
            dashboard,
            /async function prepararEdicaoAutoTrader\(id\)/
        );

        assert.match(
            dashboard,
            /await atualizarFontesAutoTrader\(cf\.fontes_sinal \|\| \[\]\)/
        );
    }
);

test(
    'MC18: POST e PUT devolvem erro BUG051D estruturado em vez de 500 genérico',
    () => {
        const bot =
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'bot2_coletor.js'
                ),
                'utf8'
            );

        const guards =
            bot.match(
                /e\s*&&\s*e\.code === 'BUG051D_CONFIG_INVALIDA'/g
            ) || [];

        assert.equal(
            guards.length,
            2
        );

        assert.match(
            bot,
            /erro: 'configuracao_auto_trader_invalida'/
        );

        assert.match(
            bot,
            /campo: e\.campo_configuracao \|\| null/
        );

        assert.match(
            bot,
            /return res\.status\(400\)\.json\(/
        );
    }
);
