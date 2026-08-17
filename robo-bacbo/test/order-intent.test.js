"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

function carregarTransporte(fetchImpl) {
    const inicio = source.indexOf("async function enviarOrdemAoExecutor");
    const fim = source.indexOf("if (!hostNodeEhLoopback(NODE_HOST))", inicio);
    assert.ok(inicio >= 0 && fim > inicio, "trecho de transporte do executor deve existir");
    const trecho = source.slice(inicio, fim);

    const contexto = {
        module: { exports: {} },
        exports: {},
        crypto: require("node:crypto"),
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: fetchImpl,
        console: { log() {}, warn() {}, error() {} },
        dbPool: { query: async () => [{ affectedRows: 1 }] },
        Number,
        String,
        Error
    };
    vm.createContext(contexto);
    vm.runInContext(`
        const EXECUTOR_URL = "http://executor.test/apostar";
        const EXECUTOR_MAX_ATTEMPTS = 2;
        const EXECUTOR_TIMEOUT_MS = 50;
        function headersInternos() { return { "Content-Type": "application/json", "X-Internal-Token": "test" }; }
        ${trecho}
        module.exports = { enviarOrdemAoExecutor, classificarStatusFalhaEnvioExecutor };
    `, contexto, { filename: "bug014a-transport.js" });
    return contexto.module.exports;
}

test("HTTP 4xx do executor e falha definitiva e nao faz retry", async () => {
    let chamadas = 0;
    const logic = carregarTransporte(async () => {
        chamadas++;
        return {
            ok: false,
            status: 400,
            json: async () => ({ erro: "payload recusado" })
        };
    });

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("BankerWon", 10, "11111111-1111-4111-8111-111111111111"),
        erro => erro && erro.envio_ambiguo === false
    );
    assert.equal(chamadas, 1);
    assert.equal(logic.classificarStatusFalhaEnvioExecutor({ envio_ambiguo: false }), "FALHA_ENVIO");
});

test("HTTP 5xx do executor e ambiguo, repete uma vez com o mesmo order_id", async () => {
    let chamadas = 0;
    const corpos = [];
    const logic = carregarTransporte(async (_url, options) => {
        chamadas++;
        corpos.push(JSON.parse(options.body));
        return {
            ok: false,
            status: 503,
            json: async () => ({ erro: "indisponivel" })
        };
    });

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, "22222222-2222-4222-8222-222222222222"),
        erro => erro && erro.envio_ambiguo === true
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
    assert.equal(logic.classificarStatusFalhaEnvioExecutor({ envio_ambiguo: true }), "ENVIO_AMBIGUO");
});

test("DIRETO e GALE persistem PREPARANDO antes do POST ao executor", () => {
    const diretoIntent = source.indexOf("intencaoDireto = await criarIntencaoOrdem(dbPool");
    const diretoSend = source.indexOf(
        "await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto)",
        diretoIntent
    );
    assert.ok(diretoIntent >= 0 && diretoSend > diretoIntent);

    const galeIntent = source.indexOf("intencaoGale = await criarIntencaoOrdem(conexaoGale");
    const galeCommit = source.indexOf("await conexaoGale.commit();", galeIntent);
    const galeSend = source.indexOf(
        "await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale)",
        galeIntent
    );
    assert.ok(galeIntent >= 0 && galeCommit > galeIntent && galeSend > galeCommit);

    assert.match(source, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'PREPARANDO'\)/);
    assert.match(source, /FALHA_ENVIO/);
    assert.match(source, /ENVIO_AMBIGUO/);
});
