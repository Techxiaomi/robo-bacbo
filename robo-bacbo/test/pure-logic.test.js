"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const frontendPath = path.join(__dirname, "..", "public", "index.html");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");
const frontendSource = fs.readFileSync(frontendPath, "utf8").replace(/\r\n/g, "\n");

function trechoEntre(inicio, fim) {
    const posInicio = source.indexOf(inicio);
    if (posInicio < 0) {
        throw new Error(`Marcador inicial nao encontrado: ${inicio}`);
    }

    const posFim = source.indexOf(fim, posInicio);
    if (posFim < 0) {
        throw new Error(`Marcador final nao encontrado: ${fim}`);
    }

    return source.slice(posInicio, posFim);
}

function carregarLogicaPura() {
    const trechos = [
        trechoEntre(
            "function calcularFichaSegura",
            "// ==========================================\n// 5. ROTAS DE API"
        ),
        trechoEntre(
            "function nivelHistoricoResultado",
            "async function registrarHistoricoResultadoEstrategia"
        ),
        trechoEntre(
            "function contarTiesLegados",
            "async function calcularAssertividadePersistidaEstrategia"
        ),
        trechoEntre(
            "function roboSintonizaEstrategia",
            "function estadoProtecaoDoRobo"
        ),
        trechoEntre(
            "function formatarPadraoTelegram",
            "async function enviarMensagemTelegram"
        ),
        trechoEntre(
            "function horarioParaMinutos",
            "async function carregarSistemasParaMemoria"
        )
    ];

    const contexto = {
        module: { exports: {} },
        exports: {},
        console,
        Date,
        Math,
        Number,
        String,
        Array,
        Object,
        JSON
    };
    vm.createContext(contexto);

    vm.runInContext(
        `${trechos.join("\n")}\nmodule.exports = {
            calcularFichaSegura,
            nivelHistoricoResultado,
            contarTiesLegados,
            roboSintonizaEstrategia,
            avaliarStopRedsRobo,
            formatarPadraoTelegram,
            montarMensagemTelegram,
            horarioParaMinutos,
            traderDentroHorarioExecucao,
            avaliarLimitesFinanceirosTrader,
            avaliarTrailingStopTrader,
            avaliarStopRedsAutoTrader
        };`,
        contexto,
        { filename: "pure-logic-from-bot2.js" }
    );

    return contexto.module.exports;
}

const logic = carregarLogicaPura();

function relogio(horas, minutos) {
    return {
        getHours: () => horas,
        getMinutes: () => minutos
    };
}

test("calcularFichaSegura arredonda para fichas de 5 e rejeita valores invalidos", () => {
    assert.equal(logic.calcularFichaSegura(0), 0);
    assert.equal(logic.calcularFichaSegura(-10), 0);
    assert.equal(logic.calcularFichaSegura("abc"), 0);
    assert.equal(logic.calcularFichaSegura(2), 5);
    assert.equal(logic.calcularFichaSegura(7.4), 5);
    assert.equal(logic.calcularFichaSegura(7.5), 10);
    assert.equal(logic.calcularFichaSegura(12.5), 15);
});

test("nivelHistoricoResultado preserva DIRETO/GALE1/GALE2", () => {
    assert.equal(logic.nivelHistoricoResultado(0), "DIRETO");
    assert.equal(logic.nivelHistoricoResultado(1), "GALE1");
    assert.equal(logic.nivelHistoricoResultado(2), "GALE2");
    assert.equal(logic.nivelHistoricoResultado(3), "DIRETO");
});

test("contarTiesLegados soma somente niveis conhecidos e tolera JSON invalido", () => {
    const ties = {
        direto: { "4x": 2, "6x": 1 },
        gale1: { "10x": 3 },
        gale2: { "25x": 4 },
        outro: { "88x": 999 }
    };

    assert.equal(logic.contarTiesLegados(ties), 10);
    assert.equal(logic.contarTiesLegados(JSON.stringify(ties)), 10);
    assert.equal(logic.contarTiesLegados("{json-invalido"), 0);
    assert.equal(logic.contarTiesLegados(null), 0);
});

test("roboSintonizaEstrategia aplica excecao > avulso > origem", () => {
    const est = { id: 10, origem: "Origem A", is_dinamico: false };

    assert.equal(logic.roboSintonizaEstrategia({
        id: 1,
        config: {
            excecoes: ["10"],
            avulsos: ["10"],
            origens: ["Origem A"]
        }
    }, est), false);

    assert.equal(logic.roboSintonizaEstrategia({
        id: 1,
        config: {
            excecoes: [],
            avulsos: ["10"],
            origens: []
        }
    }, est), true);

    assert.equal(logic.roboSintonizaEstrategia({
        id: 1,
        config: {
            excecoes: [],
            avulsos: [],
            origens: ["Origem A"]
        }
    }, est), true);

    assert.equal(logic.roboSintonizaEstrategia({
        id: 1,
        config: {}
    }, est), false);
});

test("robo dinamico pertence exclusivamente ao robo_dono_id", () => {
    const est = {
        id: "din-1",
        origem: "IA",
        is_dinamico: true,
        robo_dono_id: "7"
    };

    assert.equal(logic.roboSintonizaEstrategia({ id: 7, config: {} }, est), true);
    assert.equal(logic.roboSintonizaEstrategia({ id: 8, config: {} }, est), false);
});

test("formatarPadraoTelegram preserva a representacao visual do sinal", () => {
    assert.equal(
        logic.formatarPadraoTelegram(["Player", "Banker", "Tie", "X"]),
        "🔵 P → 🔴 B → 🟡 T → X"
    );
    assert.equal(logic.formatarPadraoTelegram(null), "");
});

test("montarMensagemTelegram respeita flags e limita texto a 4096 caracteres", () => {
    const est = {
        nome: "Padrao Teste",
        entrada: "Player",
        padrao: ["Player", "Banker"]
    };
    const estado = { assertividadeSinal: 87.25 };

    const mensagem = logic.montarMensagemTelegram(
        "ENTRADA",
        est,
        estado,
        {
            config: {
                cabecalho: "SALA A",
                rodape: "FIM",
                mostrar_nome: true,
                mostrar_padrao: true,
                mostrar_assertividade: true
            }
        }
    );

    assert.match(mensagem, /🎯 ENTRADA/);
    assert.match(mensagem, /Estratégia: Padrao Teste/);
    assert.match(mensagem, /Padrão: 🔵 P → 🔴 B/);
    assert.match(mensagem, /Assertividade: 87\.3%/);
    assert.match(mensagem, /Entrada: 🔵 PLAYER/);

    const enorme = logic.montarMensagemTelegram(
        "RED",
        est,
        estado,
        { config: { cabecalho: "X".repeat(5000) } }
    );
    assert.equal(enorme.length, 4096);
});

test("horarioParaMinutos valida formato HH:MM estrito", () => {
    assert.equal(logic.horarioParaMinutos("00:00", "12:34"), 0);
    assert.equal(logic.horarioParaMinutos("23:59", "12:34"), 1439);
    assert.equal(logic.horarioParaMinutos("", "08:30"), 510);
    assert.equal(logic.horarioParaMinutos("24:00", "08:30"), null);
    assert.equal(logic.horarioParaMinutos("8:30", "08:30"), null);
    assert.equal(logic.horarioParaMinutos("12:60", "08:30"), null);
});

test("traderDentroHorarioExecucao cobre janela normal, full-day e overnight", () => {
    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "08:00", hora_fim: "17:00" },
            relogio(8, 0)
        ),
        true
    );
    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "08:00", hora_fim: "17:00" },
            relogio(17, 0)
        ),
        true
    );
    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "08:00", hora_fim: "17:00" },
            relogio(17, 1)
        ),
        false
    );

    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "09:00", hora_fim: "09:00" },
            relogio(3, 15)
        ),
        true
    );

    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "22:00", hora_fim: "06:00" },
            relogio(23, 30)
        ),
        true
    );
    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "22:00", hora_fim: "06:00" },
            relogio(5, 59)
        ),
        true
    );
    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "22:00", hora_fim: "06:00" },
            relogio(12, 0)
        ),
        false
    );

    assert.equal(
        logic.traderDentroHorarioExecucao(
            { hora_inicio: "invalido", hora_fim: "17:00" },
            relogio(12, 0)
        ),
        false
    );
});

test("handlers fatais encerram o Node e promises Telegram fire-and-forget possuem catch local", () => {
    const exits = source.match(/process\.exit\(1\);/g) || [];
    assert.equal(exits.length, 2);

    assert.match(
        source,
        /process\.on\('uncaughtException'[\s\S]*?ERRO CRÍTICO NÃO TRATADO; encerrando processo:[\s\S]*?process\.exit\(1\);/
    );
    assert.match(
        source,
        /process\.on\('unhandledRejection'[\s\S]*?REJEIÇÃO DE PROMISE NÃO TRATADA; encerrando processo:[\s\S]*?process\.exit\(1\);/
    );

    assert.match(source, /enviarTelegramParaInscritos\('GREEN'[\s\S]*?\.catch\(e => \{[\s\S]*?Telegram GREEN/);
    assert.match(source, /enviarTelegramParaInscritos\('GALE'[\s\S]*?\.catch\(e => \{[\s\S]*?Telegram GALE/);
    assert.match(source, /enviarAvisosProtecaoTelegram\(st, avisosProtecao\);[\s\S]*?\}\)\(\)\.catch\(e => \{[\s\S]*?Telegram RED\/proteção/);
});

test("avaliarLimitesFinanceirosTrader aplica Stop Win/Stop Loss somente com saldo fresco", () => {
    let r = logic.avaliarLimitesFinanceirosTrader(
        { saldo_inicial: 1000, config: { stop_win: 100, stop_loss: 250 } },
        { saldo_atual: 1100, fresco: true }
    );
    assert.equal(r.permitido, false);
    assert.equal(r.motivo, "STOP_WIN");
    assert.equal(r.variacao, 100);

    r = logic.avaliarLimitesFinanceirosTrader(
        { saldo_inicial: 1000, config: { stop_win: 100, stop_loss: 250 } },
        { saldo_atual: 750, fresco: true }
    );
    assert.equal(r.permitido, false);
    assert.equal(r.motivo, "STOP_LOSS");
    assert.equal(r.variacao, -250);

    r = logic.avaliarLimitesFinanceirosTrader(
        { saldo_inicial: 1000, config: { stop_win: 100, stop_loss: 250 } },
        { saldo_atual: 900, fresco: true }
    );
    assert.equal(r.permitido, true);
    assert.equal(r.motivo, null);

    r = logic.avaliarLimitesFinanceirosTrader(
        { saldo_inicial: 1000, config: { stop_win: 100, stop_loss: 250 } },
        { saldo_atual: 1200, fresco: false }
    );
    assert.equal(r.permitido, false);
    assert.equal(r.motivo, "SALDO_INDISPONIVEL");
});

test("nova entrada DIRETO passa pelo guard financeiro antes do executor", () => {
    assert.match(
        source,
        /if \(!\(await autorizarNovaEntradaFinanceiraTrader\(trader\)\)\) \{[\s\S]*?continue;[\s\S]*?if \(cf\.limite_entradas/
    );
    assert.match(
        source,
        /autorizarNovaEntradaFinanceiraTrader[\s\S]*?UPDATE auto_traders SET ativo=false, status_operacao=\?, saldo_atual=\?/
    );
});

test("avaliarStopRedsAutoTrader aplica pausa, desligamento e reset por sequencia finalizada", () => {
    let r = logic.avaliarStopRedsAutoTrader(
        {
            reds_consecutivos: 2,
            config: {
                stop_reds_seguidos: 3,
                stop_reds_acao: "PAUSAR",
                stop_reds_pausa_min: 30
            }
        },
        "RED",
        1000
    );
    assert.equal(r.acao, "PAUSAR");
    assert.equal(r.status_operacao, "STOP_REDS_PAUSA");
    assert.equal(r.reds_consecutivos, 0);
    assert.equal(r.stop_reds_pausado_ate, 1801000);

    r = logic.avaliarStopRedsAutoTrader(
        {
            reds_consecutivos: 1,
            config: {
                stop_reds_seguidos: 2,
                stop_reds_acao: "DESLIGAR"
            }
        },
        "RED",
        1000
    );
    assert.equal(r.acao, "DESLIGAR");
    assert.equal(r.status_operacao, "STOP_REDS");
    assert.equal(r.reds_consecutivos, 2);
    assert.equal(r.stop_reds_pausado_ate, 0);

    r = logic.avaliarStopRedsAutoTrader(
        { reds_consecutivos: 2, config: { stop_reds_seguidos: 3 } },
        "GREEN",
        1000
    );
    assert.equal(r.acao, null);
    assert.equal(r.reds_consecutivos, 0);

    r = logic.avaliarStopRedsAutoTrader(
        { reds_consecutivos: 2, config: { stop_reds_seguidos: 3 } },
        "TIE",
        1000
    );
    assert.equal(r.reds_consecutivos, 0);

    r = logic.avaliarStopRedsAutoTrader(
        { reds_consecutivos: 9, config: { stop_reds_seguidos: 0 } },
        "RED",
        1000
    );
    assert.equal(r.acao, null);
    assert.equal(r.reds_consecutivos, 0);
});

test("Stop Reds do Auto-Trader so e atualizado dentro de ordem PENDENTE realmente executada", () => {
    assert.match(
        source,
        /if \(pendentes\.length > 0\) \{[\s\S]{0,2200}processarResultadoStopRedsAutoTrader\(\s*trader,\s*isTie \? 'TIE' : 'GREEN'/
    );
    assert.match(
        source,
        /if \(pendentes\.length > 0\) \{[\s\S]{0,1600}processarResultadoStopRedsAutoTrader\(\s*trader,\s*'RED'/
    );
    assert.match(
        source,
        /rearmarAutoTradersStopRedsPausados\(\)[\s\S]*?ativarAutoTradersAguardandoMesa\(\)/
    );
});

test("Stop Reds de Robos/Canais permanece separado do Stop Reds do Auto-Trader", () => {
    assert.match(source, /ALTER TABLE auto_traders ADD COLUMN reds_consecutivos INT DEFAULT 0/);
    assert.match(source, /ALTER TABLE auto_traders ADD COLUMN stop_reds_pausado_ate BIGINT DEFAULT 0/);
    assert.match(frontendSource, /id="robo-stop-red"/);
    assert.match(frontendSource, /id="at-stop-reds"/);
    assert.match(frontendSource, /id="at-stop-reds-acao"/);
    assert.match(frontendSource, /id="at-stop-reds-pausa"/);
});

test("avaliarTrailingStopTrader arma somente com recuo explicito e dispara no recuo do pico", () => {
    let r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 100, config: { trailing_stop: true } },
        70
    );
    assert.equal(r.acionado, false);
    assert.equal(r.pico_lucro, 100);
    assert.equal(r.limite_disparo, null);

    r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 50, config: { trailing_stop: true, trailing_recuo: 30 } },
        100
    );
    assert.equal(r.acionado, false);
    assert.equal(r.pico_lucro, 100);
    assert.equal(r.limite_disparo, 70);

    r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 100, config: { trailing_stop: true, trailing_recuo: 30 } },
        71
    );
    assert.equal(r.acionado, false);

    r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 100, config: { trailing_stop: true, trailing_recuo: 30 } },
        70
    );
    assert.equal(r.acionado, true);
    assert.equal(r.limite_disparo, 70);

    r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 0, config: { trailing_stop: true, trailing_recuo: 30 } },
        -50
    );
    assert.equal(r.acionado, false);
    assert.equal(r.pico_lucro, 0);

    r = logic.avaliarTrailingStopTrader(
        { trailing_pico_lucro: 100, config: { trailing_stop: false, trailing_recuo: 30 } },
        20
    );
    assert.equal(r.acionado, false);
});

test("avaliarLimitesFinanceirosTrader integra Trailing Stop sem superar Stop Win e Stop Loss", () => {
    let r = logic.avaliarLimitesFinanceirosTrader(
        {
            saldo_inicial: 1000,
            trailing_pico_lucro: 100,
            config: {
                stop_win: 500,
                stop_loss: 500,
                trailing_stop: true,
                trailing_recuo: 30
            }
        },
        { saldo_atual: 1070, fresco: true }
    );
    assert.equal(r.permitido, false);
    assert.equal(r.motivo, "TRAILING_STOP");
    assert.equal(r.trailing_pico_lucro, 100);
    assert.equal(r.trailing_limite_disparo, 70);

    r = logic.avaliarLimitesFinanceirosTrader(
        {
            saldo_inicial: 1000,
            trailing_pico_lucro: 80,
            config: {
                stop_win: 500,
                stop_loss: 500,
                trailing_stop: true,
                trailing_recuo: 30
            }
        },
        { saldo_atual: 1100, fresco: true }
    );
    assert.equal(r.permitido, true);
    assert.equal(r.trailing_pico_lucro, 100);

    r = logic.avaliarLimitesFinanceirosTrader(
        {
            saldo_inicial: 1000,
            trailing_pico_lucro: 100,
            config: {
                stop_win: 100,
                stop_loss: 500,
                trailing_stop: true,
                trailing_recuo: 30
            }
        },
        { saldo_atual: 1100, fresco: true }
    );
    assert.equal(r.motivo, "STOP_WIN");

    r = logic.avaliarLimitesFinanceirosTrader(
        {
            saldo_inicial: 1000,
            trailing_pico_lucro: 100,
            config: {
                stop_win: 500,
                stop_loss: 250,
                trailing_stop: true,
                trailing_recuo: 30
            }
        },
        { saldo_atual: 750, fresco: true }
    );
    assert.equal(r.motivo, "STOP_LOSS");
});

test("Trailing Stop persiste pico, reinicia ao mudar configuracao e possui controles no painel", () => {
    assert.match(source, /ALTER TABLE auto_traders ADD COLUMN trailing_pico_lucro DECIMAL\(12,2\) DEFAULT 0/);
    assert.match(source, /UPDATE auto_traders SET trailing_pico_lucro=\? WHERE id=\?/);
    assert.match(source, /trailingConfigMudou[\s\S]*?trailing_pico_lucro=0/);
    assert.match(source, /status_operacao='STANDBY'[\s\S]*?trailing_pico_lucro=0/);
    assert.match(frontendSource, /id="at-trailing-recuo"/);
    assert.match(frontendSource, /toggleTrailingStopAutoTrader/);
    assert.match(frontendSource, /TRAILING_STOP/);
});

test("avaliarStopRedsRobo desliga somente no limite consecutivo e GREEN/TIE resetam", () => {
    let r = logic.avaliarStopRedsRobo(
        { stop_reds_seguidos: 3, reds_consecutivos: 1 },
        "RED"
    );
    assert.equal(r.reds_consecutivos, 2);
    assert.equal(r.desligar, false);
    assert.equal(r.limite, 3);

    r = logic.avaliarStopRedsRobo(
        { stop_reds_seguidos: 3, reds_consecutivos: 2 },
        "RED"
    );
    assert.equal(r.reds_consecutivos, 3);
    assert.equal(r.desligar, true);

    r = logic.avaliarStopRedsRobo(
        { stop_reds_seguidos: 3, reds_consecutivos: 2 },
        "GREEN"
    );
    assert.equal(r.reds_consecutivos, 0);
    assert.equal(r.desligar, false);

    r = logic.avaliarStopRedsRobo(
        { stop_reds_seguidos: 3, reds_consecutivos: 2 },
        "TIE"
    );
    assert.equal(r.reds_consecutivos, 0);
    assert.equal(r.desligar, false);

    r = logic.avaliarStopRedsRobo(
        { stop_reds_seguidos: 0, reds_consecutivos: 9 },
        "RED"
    );
    assert.equal(r.reds_consecutivos, 0);
    assert.equal(r.desligar, false);
});

test("Stop Reds de Robos conta somente inscritos, precede cooldown e permanece independente do Auto-Trader", () => {
    assert.match(
        source,
        /ALTER TABLE robos_canais ADD COLUMN reds_consecutivos INT DEFAULT 0/
    );
    assert.match(
        source,
        /const idsInscritos = new Set\([\s\S]*?if \(!idsInscritos\.has\(String\(robo\.id\)\)\) continue;/
    );
    assert.match(
        source,
        /if \(stopReds\.desligar\) \{[\s\S]*?SET ativo=false, greens_consecutivos=0, reds_consecutivos=\?[\s\S]*?continue;[\s\S]*?if \(!cooldownAtivo\)/
    );
    assert.match(
        source,
        /SELECT ativo, stop_reds_seguidos FROM robos_canais WHERE id=\? LIMIT 1[\s\S]*?reds_consecutivos=0/
    );
    assert.match(frontendSource, /id="robo-stop-red"/);
    assert.match(frontendSource, /STOP REDS — DESLIGADO/);
    assert.match(frontendSource, /id="at-stop-reds"/);
    assert.match(frontendSource, /id="at-stop-reds-acao"/);
});
