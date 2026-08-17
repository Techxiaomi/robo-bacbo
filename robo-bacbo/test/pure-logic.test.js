"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

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
            formatarPadraoTelegram,
            montarMensagemTelegram,
            horarioParaMinutos,
            traderDentroHorarioExecucao
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
