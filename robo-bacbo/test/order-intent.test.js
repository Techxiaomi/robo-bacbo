"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

const arbiterPath = path.join(
    __dirname,
    "..",
    "auto_trader_round_arbiter.js"
);
const arbiterSource = fs.readFileSync(
    arbiterPath,
    "utf8"
).replace(/\r\n/g, "\n");

function carregarTransporte(fetchImpl, executionTimeout = 60) {
    const inicio = source.indexOf("function criarEsperaResultadoExecutor");
    const fim = source.indexOf("async function criarIntencaoOrdem", inicio);
    assert.ok(inicio >= 0 && fim > inicio, "trecho de lifecycle do executor deve existir");
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
        Number,
        String,
        Error,
        Map,
        Set,
        Date,
        Promise
    };
    vm.createContext(contexto);
    vm.runInContext(`
        const EXECUTOR_URL = "http://executor.test/apostar";
        const EXECUTOR_MAX_ATTEMPTS = 2;
        const EXECUTOR_TIMEOUT_MS = 40;
        const EXECUTOR_EXECUTION_TIMEOUT_MS = ${executionTimeout};
        const CONFIRMACOES_EXECUTOR_PENDENTES = new Map();
        function headersInternos() { return { "Content-Type": "application/json", "X-Internal-Token": "test" }; }
        ${trecho}
        module.exports = {
            enviarOrdemAoExecutor,
            registrarResultadoExecucaoExecutor,
            classificarStatusFalhaEnvioExecutor,
            CONFIRMACOES_EXECUTOR_PENDENTES
        };
    `, contexto, { filename: "bug014b-lifecycle.js" });
    return contexto.module.exports;
}

test("503 aceita=false e recusa definitiva sem retry", async () => {
    let chamadas = 0;
    const logic = carregarTransporte(async () => {
        chamadas++;
        return {
            ok: false,
            status: 503,
            json: async () => ({ erro: "Executor Playwright nao esta pronto", aceita: false })
        };
    });

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("BankerWon", 10, "11111111-1111-4111-8111-111111111111"),
        erro => erro && erro.envio_ambiguo === false
    );
    assert.equal(chamadas, 1);
    assert.equal(logic.CONFIRMACOES_EXECUTOR_PENDENTES.size, 0);
});

test("5xx sem aceita=false continua ambiguo, repete o mesmo ID e aceita callback tardio", async () => {
    let chamadas = 0;
    let registrar = null;
    const corpos = [];
    const orderId = "22222222-2222-4222-8222-222222222222";
    const logic = carregarTransporte(async (_url, options) => {
        chamadas++;
        corpos.push(JSON.parse(options.body));
        if (chamadas === 2) {
            assert.equal(registrar({ order_id: orderId, status: "AMBIGUA", motivo: "resposta HTTP perdida" }), true);
        }
        return { ok: false, status: 503, json: async () => ({ erro: "indisponivel" }) };
    });
    registrar = logic.registrarResultadoExecucaoExecutor;

    const plano = [
        { alvo: "PlayerWon", valor: 15 },
        { alvo: "Tie", valor: 5 }
    ];
    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, orderId, plano),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "AMBIGUA"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
    assert.deepEqual(corpos[0].apostas, plano);
    assert.deepEqual(corpos[1], corpos[0]);
    assert.equal(corpos[0].alvo, undefined);
    assert.equal(corpos[0].valor, undefined);
});

test("callback EXECUTADA pode chegar antes do ACK HTTP", async () => {
    let registrar = null;
    const orderId = "33333333-3333-4333-8333-333333333333";
    const logic = carregarTransporte(async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.order_id, orderId);
        assert.equal(registrar({
            order_id: orderId,
            status: "EXECUTADA",
            motivo: "Aceite financeiro confirmado",
            confirmacao: {
                confirmada: true,
                metodo: "SALDO_DEBITADO",
                saldo_antes: 100,
                saldo_depois: 90,
                exposicao_esperada: 10,
                debito_observado: 10,
                confirmada_em: Date.now()
            }
        }), true);
        return {
            ok: true,
            status: 200,
            json: async () => ({ status: "fila", duplicada: false, dados: payload })
        };
    });
    registrar = logic.registrarResultadoExecucaoExecutor;

    const resultado = await logic.enviarOrdemAoExecutor("BankerWon", 10, orderId);
    assert.equal(resultado.execucao.status, "EXECUTADA");
    assert.equal(resultado.dados.order_id, orderId);
    assert.equal(logic.CONFIRMACOES_EXECUTOR_PENDENTES.size, 0);
});

test("callback FALHOU vira FALHA_EXECUCAO e callback EXPIRADA vira ORDEM_EXPIRADA", async () => {
    for (const [status, esperado] of [["FALHOU", "FALHA_EXECUCAO"], ["EXPIRADA", "ORDEM_EXPIRADA"]]) {
        let registrar = null;
        const orderId = status === "FALHOU"
            ? "44444444-4444-4444-8444-444444444444"
            : "55555555-5555-4555-8555-555555555555";
        const logic = carregarTransporte(async (_url, options) => {
            const payload = JSON.parse(options.body);
            registrar({ order_id: orderId, status, motivo: status });
            return { ok: true, status: 200, json: async () => ({ dados: payload, duplicada: false }) };
        });
        registrar = logic.registrarResultadoExecucaoExecutor;

        await assert.rejects(
            () => logic.enviarOrdemAoExecutor("PlayerWon", 10, orderId),
            erro => erro && logic.classificarStatusFalhaEnvioExecutor(erro) === esperado
        );
    }
});

test("DIRETO e GALE continuam persistindo PREPARANDO antes do POST ao executor", () => {
    const diretoIntent = arbiterSource.indexOf(
        "intencaoDireto = await deps.criarIntencaoOrdem(conexaoIntencao"
    );
    const diretoCommit = arbiterSource.indexOf(
        "await conexaoIntencao.commit();",
        diretoIntent
    );
    const diretoSend = arbiterSource.indexOf(
        "const confirmacaoExecutorDireto = await deps.enviarOrdemAoExecutor(",
        diretoIntent
    );

    assert.ok(
        diretoIntent >= 0
        && diretoCommit > diretoIntent
        && diretoSend > diretoCommit
    );

    const galeIntent = source.indexOf("intencaoGale = await criarIntencaoOrdem(conexaoGale");
    const galeCommit = source.indexOf("await conexaoGale.commit();", galeIntent);
    const galeSend = source.indexOf(
        "const confirmacaoExecutorGale = await enviarOrdemAoExecutor(",
        galeIntent
    );
    assert.ok(galeIntent >= 0 && galeCommit > galeIntent && galeSend > galeCommit);
    assert.match(source, /FALHA_EXECUCAO/);
    assert.match(source, /ORDEM_EXPIRADA/);
});
