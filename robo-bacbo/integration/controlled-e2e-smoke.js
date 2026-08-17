"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mysql = require("mysql2/promise");

const HOST = "127.0.0.1";
const NODE_PORT = Number(process.env.E2E_NODE_PORT || 3127);
const EXECUTOR_PORT = Number(process.env.E2E_EXECUTOR_PORT || 5127);
const BASE_URL = `http://${HOST}:${NODE_PORT}`;
const INTERNAL_API_TOKEN = "obs003h-internal-token-123456789";
const COLLECTOR_SESSION = "obs003h-controlled-collector";

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const emitterPath = path.join(
    __dirname,
    "..",
    "..",
    "robo-sync-pilot",
    "integration",
    "emit-controlled-result.py"
);

let backendOutput = "";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function recordBackendOutput(chunk, stream) {
    const text = String(chunk || "");
    backendOutput += text;
    stream.write(text);
}

async function requestNode(route, options = {}) {
    return fetch(`${BASE_URL}${route}`, {
        redirect: "manual",
        ...options
    });
}

async function waitUntil(label, predicate, timeoutMs = 12000, intervalMs = 100) {
    const started = Date.now();
    let lastError = null;

    while ((Date.now() - started) < timeoutMs) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(intervalMs);
    }

    const suffix = lastError ? ` Último erro: ${lastError.message}` : "";
    throw new Error(`Timeout aguardando ${label}.${suffix}`);
}

async function startFakeExecutor() {
    const orders = [];
    let handlerError = null;

    const server = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/apostar") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ erro: "rota_inexistente" }));
            return;
        }

        let raw = "";
        req.setEncoding("utf8");
        req.on("data", chunk => {
            raw += chunk;
        });
        req.on("end", () => {
            try {
                if (req.headers["x-internal-token"] !== INTERNAL_API_TOKEN) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ erro: "Nao autorizado" }));
                    return;
                }

                const payload = JSON.parse(raw || "{}");
                if (
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                        String(payload.order_id || "")
                    )
                ) {
                    throw new Error("order_id inválido recebido pelo executor fake");
                }
                if (!["PlayerWon", "BankerWon", "Tie"].includes(payload.alvo)) {
                    throw new Error(`alvo inválido recebido pelo executor fake: ${payload.alvo}`);
                }
                if (!(Number(payload.valor) > 0)) {
                    throw new Error(`valor inválido recebido pelo executor fake: ${payload.valor}`);
                }

                orders.push({
                    payload,
                    token: req.headers["x-internal-token"]
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: "Aposta na fila de execucao!",
                    duplicada: false,
                    dados: payload
                }));
            } catch (error) {
                handlerError = error;
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ erro: error.message }));
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(EXECUTOR_PORT, HOST, resolve);
    });

    return {
        orders,
        getHandlerError: () => handlerError,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

async function emitControlledResult({ seq, winner, p1, p2, b1, b2 }) {
    const python = process.env.PYTHON_BIN || "python";
    const args = [
        emitterPath,
        "--node-url", `${BASE_URL}/receber-sinal`,
        "--token", INTERNAL_API_TOKEN,
        "--session", COLLECTOR_SESSION,
        "--seq", String(seq),
        "--winner", winner,
        "--p1", String(p1),
        "--p2", String(p2),
        "--b1", String(b1),
        "--b2", String(b2)
    ];

    const child = spawn(python, args, {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
        const text = String(chunk || "");
        stdout += text;
        process.stdout.write(text);
    });
    child.stderr.on("data", chunk => {
        const text = String(chunk || "");
        stderr += text;
        process.stderr.write(text);
    });

    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code));
    });

    assert.equal(
        exitCode,
        0,
        `Emissor Python falhou para seq=${seq}. stdout=${stdout} stderr=${stderr}`
    );
    assert.match(stdout, new RegExp(`CONTROLLED_RESULT_SENT.*seq=${seq}\\b`));
}

async function main() {
    const fakeExecutor = await startFakeExecutor();
    const childEnv = {
        ...process.env,
        DB_HOST: "127.0.0.1",
        DB_PORT: "3306",
        DB_USER: "root",
        DB_PASSWORD: "root",
        DB_NAME: "bacbo_e2e",
        NODE_HOST: HOST,
        NODE_PORT: String(NODE_PORT),
        EXECUTOR_URL: `http://${HOST}:${EXECUTOR_PORT}/apostar`,
        INTERNAL_API_TOKEN,
        ADMIN_USERNAME: "",
        ADMIN_PASSWORD: "",
        BALANCE_SYNC_MAX_AGE_SECONDS: "90",
        LOG_FILE_ENABLED: "false"
    };

    const backend = spawn(process.execPath, [backendPath], {
        cwd: path.join(__dirname, ".."),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"]
    });

    backend.stdout.on("data", chunk => recordBackendOutput(chunk, process.stdout));
    backend.stderr.on("data", chunk => recordBackendOutput(chunk, process.stderr));

    let db = null;

    try {
        await waitUntil("backendPronto=true", async () => {
            if (backend.exitCode !== null) {
                throw new Error(`Backend encerrou durante startup (exit=${backend.exitCode})`);
            }
            try {
                const response = await requestNode("/api/dashboard-stats");
                return response.status === 200;
            } catch (error) {
                return false;
            }
        }, 30000, 250);

        db = await mysql.createConnection({
            host: "127.0.0.1",
            port: 3306,
            user: "root",
            password: "root",
            database: "bacbo_e2e"
        });

        const balanceResponse = await requestNode("/receber-sinal", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": INTERNAL_API_TOKEN
            },
            body: JSON.stringify({
                saldo_atual: 1000,
                timestamp_coleta: Date.now()
            })
        });
        assert.equal(balanceResponse.status, 200);
        assert.deepEqual(await balanceResponse.json(), {
            recebido: true,
            saldo_atual: 1000
        });

        const strategyResponse = await requestNode("/api/novo-padrao", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                nome: "OBS-003H E2E Pattern",
                origem: "OBS003H",
                padrao: "Player",
                entrada: "Banker",
                gales: 0,
                protegerEmpate: false,
                ativo: true
            })
        });
        assert.equal(strategyResponse.status, 200);
        assert.deepEqual(await strategyResponse.json(), { sucesso: true });

        const [[strategy]] = await db.query(
            "SELECT id, nome, origem, padrao, entrada, gales, ativo FROM estrategias WHERE nome=? LIMIT 1",
            ["OBS-003H E2E Pattern"]
        );
        assert.ok(strategy);
        assert.equal(strategy.origem, "OBS003H");
        assert.equal(strategy.entrada, "Banker");
        assert.equal(Number(strategy.gales), 0);
        assert.equal(Number(strategy.ativo), 1);
        assert.deepEqual(JSON.parse(strategy.padrao), ["Player"]);

        const traderResponse = await requestNode("/api/auto-trader", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                nome: "OBS-003H Trader",
                ativo: true,
                config: {
                    stake_inicial: 10,
                    gale_1_mult: 2,
                    gale_2_mult: 4,
                    modo_camuflagem: "TODAS",
                    camuflagem_pulos_min: 1,
                    camuflagem_pulos_max: 1,
                    limite_entradas: 5,
                    stop_win: 500,
                    stop_loss: 500,
                    trailing_stop: false,
                    trailing_recuo: 0,
                    stop_reds_seguidos: 0,
                    stop_reds_acao: "PAUSAR",
                    stop_reds_pausa_min: 60,
                    hora_inicio: "00:00",
                    hora_fim: "23:59",
                    fontes_sinal: ["OBS003H"]
                }
            })
        });
        assert.equal(traderResponse.status, 200);
        assert.deepEqual(await traderResponse.json(), {
            sucesso: true,
            saldo_inicial: 1000
        });

        const [[traderBefore]] = await db.query(
            "SELECT id, ativo, status_operacao, saldo_inicial, saldo_atual, entradas_feitas FROM auto_traders WHERE nome=? LIMIT 1",
            ["OBS-003H Trader"]
        );
        assert.ok(traderBefore);
        assert.equal(Number(traderBefore.ativo), 1);
        assert.equal(traderBefore.status_operacao, "STANDBY");
        assert.equal(Number(traderBefore.saldo_inicial), 1000);
        assert.equal(Number(traderBefore.saldo_atual), 1000);
        assert.equal(Number(traderBefore.entradas_feitas), 0);

        await emitControlledResult({
            seq: 1,
            winner: "PlayerWon",
            p1: 4,
            p2: 3,
            b1: 2,
            b2: 1
        });

        await waitUntil("ordem DIRETO confirmada pelo executor fake", async () => {
            if (fakeExecutor.getHandlerError()) throw fakeExecutor.getHandlerError();
            return fakeExecutor.orders.length === 1;
        });

        const firstOrder = fakeExecutor.orders[0];
        assert.equal(firstOrder.token, INTERNAL_API_TOKEN);
        assert.equal(firstOrder.payload.alvo, "BankerWon");
        assert.equal(Number(firstOrder.payload.valor), 10);

        const pendingAudit = await waitUntil("auditoria PENDENTE da ordem DIRETO", async () => {
            const [[row]] = await db.query(
                `SELECT id, trader_id, estrategia_nome, fonte_sinal, alvo, nivel,
                        risco_total, valor_entrada, executor_order_id, status_ordem
                 FROM auditoria_ordens
                 WHERE trader_id=?
                 ORDER BY id DESC
                 LIMIT 1`,
                [traderBefore.id]
            );
            return row && row.status_ordem === "PENDENTE" ? row : null;
        });

        assert.equal(pendingAudit.estrategia_nome, "OBS-003H E2E Pattern");
        assert.equal(pendingAudit.fonte_sinal, "OBS003H");
        assert.equal(pendingAudit.alvo, "BankerWon");
        assert.equal(pendingAudit.nivel, "DIRETO");
        assert.equal(Number(pendingAudit.risco_total), 10);
        assert.equal(Number(pendingAudit.valor_entrada), 10);
        assert.equal(pendingAudit.executor_order_id, firstOrder.payload.order_id);

        const [[traderOperating]] = await db.query(
            "SELECT status_operacao, entradas_feitas FROM auto_traders WHERE id=?",
            [traderBefore.id]
        );
        assert.equal(traderOperating.status_operacao, "OPERANDO");
        assert.equal(Number(traderOperating.entradas_feitas), 1);

        const [[afterFirstSpin]] = await db.query(
            "SELECT COUNT(*) AS total FROM giros_recentes"
        );
        assert.equal(Number(afterFirstSpin.total), 1);

        await emitControlledResult({
            seq: 2,
            winner: "BankerWon",
            p1: 1,
            p2: 2,
            b1: 4,
            b2: 3
        });

        const finalizedAudit = await waitUntil("auditoria WIN da ordem DIRETO", async () => {
            const [[row]] = await db.query(
                `SELECT id, status_ordem, lucro_prejuizo, saldo_pos, placar_mesa
                 FROM auditoria_ordens
                 WHERE id=?`,
                [pendingAudit.id]
            );
            return row && row.status_ordem !== "PENDENTE" ? row : null;
        });

        assert.equal(finalizedAudit.status_ordem, "WIN");
        assert.equal(Number(finalizedAudit.lucro_prejuizo), 10);
        assert.equal(finalizedAudit.placar_mesa, "[P:3 B:7]");

        const [[history]] = await db.query(
            `SELECT tipo_resultado, nivel, multiplicador
             FROM historico_resultados
             WHERE estrategia_id=?
             ORDER BY id DESC
             LIMIT 1`,
            [strategy.id]
        );
        assert.ok(history);
        assert.equal(history.tipo_resultado, "GREEN");
        assert.equal(history.nivel, "DIRETO");
        assert.equal(history.multiplicador, "");

        const [[strategyAfter]] = await db.query(
            "SELECT green_direto, gale1, gale2, red FROM estrategias WHERE id=?",
            [strategy.id]
        );
        assert.equal(Number(strategyAfter.green_direto), 1);
        assert.equal(Number(strategyAfter.gale1), 0);
        assert.equal(Number(strategyAfter.gale2), 0);
        assert.equal(Number(strategyAfter.red), 0);

        const [[spinCount]] = await db.query(
            "SELECT COUNT(*) AS total FROM giros_recentes"
        );
        assert.equal(Number(spinCount.total), 2);

        const [[pendingCount]] = await db.query(
            "SELECT COUNT(*) AS total FROM auditoria_ordens WHERE status_ordem='PENDENTE'"
        );
        assert.equal(Number(pendingCount.total), 0);
        assert.equal(fakeExecutor.orders.length, 1);
        assert.equal(fakeExecutor.getHandlerError(), null);

        console.log("OBS-003H controlled E2E smoke: PASS");
    } catch (error) {
        console.error("OBS-003H controlled E2E smoke: FAIL", error);
        console.error("--- Saida acumulada do backend ---");
        console.error(backendOutput);
        process.exitCode = 1;
    } finally {
        if (db) {
            try { await db.end(); } catch (error) {}
        }

        if (backend.exitCode === null) {
            backend.kill("SIGTERM");
            await Promise.race([
                new Promise(resolve => backend.once("exit", resolve)),
                sleep(3000)
            ]);
            if (backend.exitCode === null) backend.kill("SIGKILL");
        }

        try { await fakeExecutor.close(); } catch (error) {}
    }
}

main().catch(error => {
    console.error("OBS-003H controlled E2E smoke: FAIL fatal", error);
    process.exitCode = 1;
});
