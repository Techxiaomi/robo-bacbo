"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

function carregarFila() {
    const inicio = source.indexOf("let caudaProcessamentoResultados = Promise.resolve();");
    const fim = source.indexOf("function reservarContinuidadeResultado", inicio);
    assert.ok(inicio >= 0 && fim > inicio, "fila BUG-014C deve existir");
    const trecho = source.slice(inicio, fim);

    const contexto = {
        module: { exports: {} },
        exports: {},
        Promise,
        Math
    };
    vm.createContext(contexto);
    vm.runInContext(`${trecho}\nmodule.exports = { aguardarTurnoProcessamentoResultado, pendentes: () => resultadosAguardandoProcessamento };`, contexto);
    return contexto.module.exports;
}

test("turnos de resultado sao FIFO e release e idempotente", async () => {
    const fila = carregarFila();
    const eventos = [];

    const liberar1 = await fila.aguardarTurnoProcessamentoResultado();
    eventos.push("1-entrou");

    let segundoEntrou = false;
    const segundo = fila.aguardarTurnoProcessamentoResultado().then(liberar2 => {
        segundoEntrou = true;
        eventos.push("2-entrou");
        assert.equal(liberar2(), true);
        assert.equal(liberar2(), false);
    });

    await Promise.resolve();
    assert.equal(segundoEntrou, false);
    assert.equal(fila.pendentes(), 2);
    assert.equal(liberar1(), true);
    assert.equal(liberar1(), false);

    await segundo;
    assert.deepEqual(eventos, ["1-entrou", "2-entrou"]);
    assert.equal(fila.pendentes(), 0);
});

test("receber-sinal reserva sequencia antes de I/O, da ACK antes do turno e sempre libera", () => {
    const inicio = source.indexOf('app.post("/receber-sinal", async (req, res) => {');
    assert.ok(inicio >= 0);
    const fim = source.indexOf("async function iniciarApp()", inicio);
    const handler = source.slice(inicio, fim);

    const reserva = handler.indexOf("const continuidade = vencedor ? reservarContinuidadeResultado(dados) : null;");
    const primeiroAwaitSaldo = handler.indexOf("await dbPool.query(");
    const ack = handler.indexOf("res.json({ recebido: true });");
    const turno = handler.indexOf("await aguardarTurnoProcessamentoResultado();");
    const interrupcao = handler.indexOf("if (continuidade.interrupcao)");
    const invalidacao = handler.indexOf("await invalidarSequenciasAposBuracoDados(motivoInterrupcao);");
    const finallyRelease = handler.indexOf("if (liberarTurnoResultado)");

    assert.ok(reserva >= 0 && primeiroAwaitSaldo > reserva, "reserva deve preceder o primeiro I/O possível");
    assert.ok(ack >= 0 && turno > ack, "ACK deve preceder espera FIFO");
    assert.ok(interrupcao > turno, "mutações pós-ACK devem ocorrer dentro do turno");
    assert.ok(invalidacao > interrupcao, "qualquer interrupção deve invalidar pendências antes do giro");
    assert.ok(finallyRelease > interrupcao, "turno deve ser liberado em finally");
});

test("collector-health serializa e persiste a invalidação antes do ACK", () => {
    const inicio = source.indexOf('app.post("/collector-health", async (req, res) => {');
    const fim = source.indexOf('app.post("/receber-sinal", async (req, res) => {', inicio);
    assert.ok(inicio >= 0 && fim > inicio, "endpoint interno de saúde deve existir");
    const handler = source.slice(inicio, fim);

    const turno = handler.indexOf("await aguardarTurnoProcessamentoResultado();");
    const invalidacao = handler.indexOf("await invalidarSequenciasAposBuracoDados(motivo);");
    const ack = handler.indexOf("continuidade: 'INVALIDADA',", invalidacao);
    const release = handler.indexOf("if (liberarTurnoResultado) liberarTurnoResultado();");

    assert.ok(turno >= 0 && invalidacao > turno, "health deve entrar na mesma FIFO dos resultados");
    assert.ok(ack > invalidacao, "ACK de saúde só pode ocorrer após invalidação persistida");
    assert.ok(release > ack, "turno de saúde deve ser liberado em finally");
    assert.match(handler, /reservaInterrupcao\.estado === 'PROCESSANDO'[\s\S]*?status\(503\)[\s\S]*?INVALIDACAO_EM_ANDAMENTO/);
    assert.match(handler, /reservaInterrupcao\.repetida[\s\S]*?INVALIDADA_ANTERIORMENTE/);
});
