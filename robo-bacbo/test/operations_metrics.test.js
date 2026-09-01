"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const metrics = require("../operations_metrics");

test.afterEach(() => {
    metrics.resetMetricasOperacionaisParaTeste();
});

test("normaliza rotas sem query, IDs numericos, UUID e hashes longos", () => {
    assert.equal(metrics.normalizarRota("/api/auto-trader/123?x=1"), "/api/auto-trader/:id");
    assert.equal(
        metrics.normalizarRota("/api/item/550e8400-e29b-41d4-a716-446655440000"),
        "/api/item/:id"
    );
    assert.equal(
        metrics.normalizarRota("/api/item/abcdefabcdefabcdefabcdefabcdefab"),
        "/api/item/:id"
    );
    assert.equal(metrics.normalizarRota("/receber-sinal?token=nao-deve-aparecer"), "/receber-sinal");
});

test("classes HTTP e resumo de latencia sao deterministas", () => {
    assert.equal(metrics.classeStatus(200), "2xx");
    assert.equal(metrics.classeStatus(302), "3xx");
    assert.equal(metrics.classeStatus(401), "4xx");
    assert.equal(metrics.classeStatus(503), "5xx");
    assert.equal(metrics.classeStatus(0), "outros");

    assert.deepEqual(metrics.resumoLatencias([10, 20, 30, 40]), {
        amostras: 4,
        media: 25,
        p50: 20,
        p95: 40,
        p99: 40,
        max: 40
    });
});

test("namespace de worker produz arquivo exclusivo sem depender do sufixo da mesa", () => {
    const config = metrics.configMetricasOperacionais({
        baseDir: "D:/Projetos/Bacbo",
        env: {
            BACBO_MESA_CODIGO: "BACBO_BR",
            OPERATIONS_METRICS_DIR: "logs",
            OPERATIONS_METRICS_NAMESPACE: "account-4-bacbo_br"
        }
    });

    assert.equal(
        path.basename(config.filePath),
        "backend.operations.account-4-bacbo_br.json"
    );
    assert.equal(
        metrics.normalizarNamespaceMetricas(" Account 4 / BACBO_BR "),
        "account-4-bacbo_br"
    );
});

test("registro HTTP agrega status e rota normalizada sem cardinalidade por ID", () => {
    metrics.resetMetricasOperacionaisParaTeste(Date.parse("2026-08-17T20:00:00.000Z"));

    metrics.registrarHttp("GET", "/api/auditoria-ordens/10", 200, 12, { maxSamples: 10, maxRoutes: 20 });
    metrics.registrarHttp("GET", "/api/auditoria-ordens/11", 500, 30, { maxSamples: 10, maxRoutes: 20 });

    const snapshot = metrics.snapshotMetricasOperacionais({
        agoraMs: Date.parse("2026-08-17T20:01:00.000Z")
    });

    assert.equal(snapshot.http.total, 2);
    assert.equal(snapshot.http.status["2xx"], 1);
    assert.equal(snapshot.http.status["5xx"], 1);
    assert.equal(snapshot.http.rotas["GET /api/auditoria-ordens/:id"].total, 2);
    assert.equal(snapshot.http.rotas["GET /api/auditoria-ordens/:id"].latencia_ms.p95, 30);
});

test("outbound classifica executor e telegram sem persistir URL", () => {
    metrics.resetMetricasOperacionaisParaTeste();

    assert.equal(
        metrics.classificarDestino(
            "http://127.0.0.1:5000/apostar",
            "http://127.0.0.1:5000/apostar"
        ),
        "executor"
    );
    assert.equal(
        metrics.classificarDestino(
            "https://api.telegram.org/botSEGREDO/sendMessage",
            "http://127.0.0.1:5000/apostar"
        ),
        "telegram"
    );
    assert.equal(metrics.classificarDestino("https://example.invalid/test"), "other");

    metrics.registrarOutbound("executor", 200, 45, false, { maxSamples: 10 });
    metrics.registrarOutbound("executor", 503, 100, false, { maxSamples: 10 });
    const snapshot = metrics.snapshotMetricasOperacionais();

    assert.deepEqual(Object.keys(snapshot.outbound_http.executor).sort(), [
        "falha", "latencia_ms", "status", "sucesso", "total"
    ]);
    assert.equal(snapshot.outbound_http.executor.total, 2);
    assert.equal(snapshot.outbound_http.executor.sucesso, 1);
    assert.equal(snapshot.outbound_http.executor.falha, 1);
    assert.equal(JSON.stringify(snapshot).includes("SEGREDO"), false);
});

test("freshness so avanca para /receber-sinal aceito", () => {
    metrics.resetMetricasOperacionaisParaTeste();
    const agora = Date.parse("2026-08-17T21:00:00.000Z");

    metrics.registrarFreshnessReq({
        url: "/receber-sinal",
        body: { vencedor: "PLAYER", saldo_atual: 123.45 }
    }, 200, agora);

    metrics.registrarFreshnessReq({
        url: "/receber-sinal",
        body: { vencedor: "BANKER", saldo_atual: 999 }
    }, 401, agora + 1000);

    const snapshot = metrics.snapshotMetricasOperacionais({ agoraMs: agora + 5000 });
    assert.equal(snapshot.freshness.ultimo_resultado_em, "2026-08-17T21:00:00.000Z");
    assert.equal(snapshot.freshness.ultimo_saldo_em, "2026-08-17T21:00:00.000Z");
    assert.equal(snapshot.freshness.idade_ultimo_resultado_seconds, 5);
    assert.equal(snapshot.freshness.idade_ultimo_saldo_seconds, 5);
});

test("persistencia JSON atomica cria snapshot valido", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bacbo-ops-metrics-"));
    const filePath = path.join(dir, "backend.operations.json");

    try {
        metrics.escreverJsonAtomico(filePath, { ok: true, segredo: undefined });
        assert.equal(fs.existsSync(filePath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { ok: true });
        assert.equal(fs.readdirSync(dir).some(nome => nome.endsWith(".tmp")), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("hooks reais medem request inbound, fetch outbound e freshness sem alterar resposta", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bacbo-ops-hook-"));
    let server = null;

    try {
        const resultadoInstalacao = metrics.instalarMetricasOperacionais({
            baseDir: dir,
            env: {
                OPERATIONS_METRICS_ENABLED: "true",
                OPERATIONS_METRICS_DIR: "logs",
                OPERATIONS_METRICS_INTERVAL_SECONDS: "300",
                EXECUTOR_URL: "http://127.0.0.1:5999/apostar"
            }
        });
        assert.equal(resultadoInstalacao.installed, true);

        server = http.createServer((req, res) => {
            req.body = { vencedor: "PLAYER", saldo_atual: 100 };
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
        });

        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        const endereco = server.address();
        const resposta = await fetch(`http://127.0.0.1:${endereco.port}/receber-sinal?segredo=oculto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
        });
        assert.equal(resposta.status, 200);
        assert.deepEqual(await resposta.json(), { ok: true });

        await new Promise(resolve => setTimeout(resolve, 20));
        const snapshot = metrics.snapshotMetricasOperacionais();

        assert.equal(snapshot.http.total, 1);
        assert.equal(snapshot.http.rotas["POST /receber-sinal"].total, 1);
        assert.equal(snapshot.http.status["2xx"], 1);
        assert.equal(snapshot.outbound_http.other.total, 1);
        assert.equal(snapshot.outbound_http.other.sucesso, 1);
        assert.notEqual(snapshot.freshness.ultimo_resultado_em, null);
        assert.notEqual(snapshot.freshness.ultimo_saldo_em, null);
        assert.equal(JSON.stringify(snapshot).includes("segredo=oculto"), false);
    } finally {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        metrics.resetMetricasOperacionaisParaTeste();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
