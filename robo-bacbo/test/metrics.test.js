"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const metrics = require("../metrics");

test.afterEach(() => {
    metrics.resetMetricasParaTeste();
});

test("config de metricas aplica defaults, limites e sanitiza nome do arquivo", () => {
    const baseDir = path.resolve(path.sep, "tmp", "bacbo-metrics-base");
    const config = metrics.configMetricas({
        baseDir,
        env: {
            METRICS_ENABLED: "true",
            LOG_DIR: "logs-custom",
            METRICS_FILE_NAME: "../fora.json",
            METRICS_INTERVAL_SECONDS: "2"
        }
    });

    assert.equal(config.enabled, true);
    assert.equal(config.filePath, path.join(baseDir, "logs-custom", "fora.json"));
    assert.equal(config.intervalMs, 5000);

    const configMax = metrics.configMetricas({
        baseDir,
        env: { METRICS_INTERVAL_SECONDS: "9999" }
    });
    assert.equal(configMax.intervalMs, 300000);
});

test("snapshot agrega memoria, event loop, logs e falhas sem segredos", () => {
    const iniciadoEm = Date.parse("2026-08-17T20:00:00.000Z");
    metrics.resetMetricasParaTeste(iniciadoEm);

    metrics.registrarLog("info", iniciadoEm + 1000);
    metrics.registrarLog("warn", iniciadoEm + 2000);
    metrics.registrarLog("error", iniciadoEm + 3000);
    metrics.registrarFalhaSinkLog(iniciadoEm + 4000);
    metrics.registrarFalhaSinkMetricas(iniciadoEm + 5000);

    const percentis = new Map([
        [50, 2e6],
        [95, 5e6],
        [99, 8e6]
    ]);
    const histograma = {
        percentile: p => percentis.get(p) || 0,
        max: 12e6,
        mean: 3.5e6
    };

    const snapshot = metrics.snapshotMetricas({
        agoraMs: iniciadoEm + 6000,
        uptimeSeconds: 6.1234,
        memoria: {
            rss: 64 * 1024 * 1024,
            heapTotal: 32 * 1024 * 1024,
            heapUsed: 16 * 1024 * 1024,
            external: 4 * 1024 * 1024,
            arrayBuffers: 2 * 1024 * 1024
        },
        histograma
    });

    assert.equal(snapshot.timestamp, "2026-08-17T20:00:06.000Z");
    assert.equal(snapshot.iniciado_em, "2026-08-17T20:00:00.000Z");
    assert.equal(snapshot.uptime_seconds, 6.123);
    assert.deepEqual(snapshot.memoria_mb, {
        rss: 64,
        heap_total: 32,
        heap_usado: 16,
        external: 4,
        array_buffers: 2
    });
    assert.deepEqual(snapshot.event_loop_delay_ms, {
        p50: 2,
        p95: 5,
        p99: 8,
        max: 12,
        media: 3.5
    });
    assert.equal(snapshot.logs.total, 3);
    assert.equal(snapshot.logs.info, 1);
    assert.equal(snapshot.logs.warn, 1);
    assert.equal(snapshot.logs.error, 1);
    assert.equal(snapshot.logs.ultimo_warn_em, "2026-08-17T20:00:02.000Z");
    assert.equal(snapshot.logs.ultimo_error_em, "2026-08-17T20:00:03.000Z");
    assert.equal(snapshot.sinks.falhas_log, 1);
    assert.equal(snapshot.sinks.falhas_metricas, 1);
});

test("persistencia atomica grava JSON valido e nao deixa temporario", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bacbo-metrics-"));
    const filePath = path.join(dir, "backend.metrics.json");

    try {
        metrics.resetMetricasParaTeste(Date.parse("2026-08-17T20:00:00.000Z"));
        metrics.registrarLog("error", Date.parse("2026-08-17T20:00:01.000Z"));

        metrics.persistirSnapshot(filePath, {
            agoraMs: Date.parse("2026-08-17T20:00:02.000Z"),
            uptimeSeconds: 2,
            memoria: {
                rss: 1,
                heapTotal: 1,
                heapUsed: 1,
                external: 1,
                arrayBuffers: 1
            },
            histograma: null
        });

        assert.equal(fs.existsSync(filePath), true);
        const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
        assert.equal(payload.logs.error, 1);
        assert.equal(payload.uptime_seconds, 2);
        assert.deepEqual(
            fs.readdirSync(dir).filter(nome => nome.endsWith(".tmp")),
            []
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("instalacao cria snapshot inicial, usa timer unref e pode ser desativada", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bacbo-metrics-install-"));
    let intervaloRecebido = null;
    let unrefChamado = false;
    let monitorHabilitado = false;
    let monitorDesabilitado = false;

    const timerFake = {
        unref() { unrefChamado = true; }
    };
    const histogramaFake = {
        enable() { monitorHabilitado = true; },
        disable() { monitorDesabilitado = true; },
        percentile() { return 0; },
        max: 0,
        mean: 0
    };

    try {
        const resultado = metrics.instalarMetricasRuntime({
            baseDir: dir,
            env: {
                METRICS_ENABLED: "true",
                METRICS_DIR: "metricas",
                METRICS_FILE_NAME: "runtime.json",
                METRICS_INTERVAL_SECONDS: "7"
            },
            monitorEventLoopDelayImpl: () => histogramaFake,
            setIntervalImpl: (_fn, ms) => {
                intervaloRecebido = ms;
                return timerFake;
            }
        });

        assert.equal(resultado.installed, true);
        assert.equal(resultado.enabled, true);
        assert.equal(resultado.intervalMs, 7000);
        assert.equal(intervaloRecebido, 7000);
        assert.equal(unrefChamado, true);
        assert.equal(monitorHabilitado, true);
        assert.equal(fs.existsSync(path.join(dir, "metricas", "runtime.json")), true);

        metrics.encerrarMetricasRuntime();
        assert.equal(monitorDesabilitado, true);

        const desativado = metrics.instalarMetricasRuntime({
            baseDir: dir,
            env: { METRICS_ENABLED: "false" }
        });
        assert.deepEqual(desativado, { installed: false, enabled: false });
    } finally {
        metrics.resetMetricasParaTeste();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
