"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mysql = require("mysql2/promise");

const HOST = "127.0.0.1";
const NODE_PORT = Number(process.env.E2E_NODE_PORT || 3127);
const EXECUTOR_PORT = Number(process.env.E2E_EXECUTOR_PORT || 5127);
const BASE_URL = `http://${HOST}:${NODE_PORT}`;
const TOKEN = String(process.env.E2E_INTERNAL_API_TOKEN ||
    `e2e-${crypto.randomUUID()}-${crypto.randomBytes(16).toString("hex")}`);
const DB_PASSWORD = String(process.env.E2E_DB_PASSWORD || "");
const SESSION = "obs003h-controlled-collector";

if (!DB_PASSWORD) {
    throw new Error("E2E_DB_PASSWORD é obrigatório para o teste controlado.");
}

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const emitterPath = path.join(
    __dirname, "..", "..", "robo-sync-pilot", "integration", "emit-controlled-result.py"
);

let backendOutput = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(label, fn, timeoutMs = 12000) {
    const start = Date.now();
    let lastError = null;
    while (Date.now() - start < timeoutMs) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await sleep(100);
    }
    throw new Error(
        `Timeout aguardando ${label}` + (lastError ? `: ${lastError.message}` : "")
    );
}

function startFakeExecutor(getDb) {
    const orders = [];
    let handlerError = null;
    const callbackDelayMs = 700;

    const server = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/apostar") {
            res.writeHead(404).end();
            return;
        }

        let raw = "";
        req.setEncoding("utf8");
        req.on("data", chunk => { raw += chunk; });
        req.on("end", async () => {
            try {
                if (req.headers["x-internal-token"] !== TOKEN) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ erro: "Nao autorizado" }));
                    return;
                }

                const payload = JSON.parse(raw || "{}");
                assert.match(
                    String(payload.order_id || ""),
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                );
                const apostas = Array.isArray(payload.apostas)
                    ? payload.apostas
                    : [{ alvo: payload.alvo, valor: payload.valor }];
                assert.ok(apostas.length >= 1 && apostas.length <= 2);
                const alvos = new Set();
                for (const perna of apostas) {
                    assert.ok(["PlayerWon", "BankerWon", "Tie"].includes(perna.alvo));
                    assert.ok(Number(perna.valor) > 0);
                    assert.equal(alvos.has(perna.alvo), false, "Plano nao pode repetir alvo");
                    alvos.add(perna.alvo);
                }
                const principal = apostas[0];
                const empate = apostas.find(perna => perna.alvo === "Tie") || null;

                const db = getDb();
                assert.ok(db, "Conexão MySQL do teste deve existir antes da primeira ordem");
                const [[intent]] = await db.query(
                    `SELECT id, trader_id, alvo, nivel, valor_entrada, valor_empate,
                            executor_order_id, status_ordem
                     FROM auditoria_ordens
                     WHERE executor_order_id=?
                     ORDER BY id DESC LIMIT 1`,
                    [payload.order_id]
                );
                assert.ok(intent, "Intenção durável deve existir antes do ACK do executor");
                assert.equal(intent.status_ordem, "PREPARANDO");
                assert.equal(intent.alvo, principal.alvo);
                assert.equal(Number(intent.valor_entrada), Number(principal.valor));
                assert.equal(Number(intent.valor_empate), empate ? Number(empate.valor) : 0);

                // Mantém a primeira rodada deliberadamente presa no executor.
                // A segunda rodada será recebida pelo Node durante este intervalo.
                await sleep(callbackDelayMs);

                const callbackResponse = await fetch(`${BASE_URL}/executor-status`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Internal-Token": TOKEN
                    },
                    body: JSON.stringify({
                        order_id: payload.order_id,
                        status: "EXECUTADA",
                        motivo: "Aceite financeiro controlado confirmado",
                        confirmacao: {
                            confirmada: true,
                            metodo: "SALDO_DEBITADO",
                            saldo_antes: 1000,
                            saldo_depois: 1000 - apostas.reduce((soma, perna) => soma + Number(perna.valor), 0),
                            exposicao_esperada: apostas.reduce((soma, perna) => soma + Number(perna.valor), 0),
                            debito_observado: apostas.reduce((soma, perna) => soma + Number(perna.valor), 0),
                            confirmada_em: Date.now()
                        }
                    })
                });
                const callbackData = await callbackResponse.json();
                assert.equal(callbackResponse.status, 200);
                assert.equal(callbackData.recebido, true);
                assert.equal(callbackData.orfa, false, "callback antecipado deve encontrar waiter do Node");

                orders.push({
                    payload,
                    apostas,
                    token: req.headers["x-internal-token"],
                    intentStatusBeforeAck: intent.status_ordem,
                    intentIdBeforeAck: Number(intent.id),
                    callbackBeforeAck: true,
                    callbackDelayMs
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

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(EXECUTOR_PORT, HOST, () => resolve({
            orders,
            getError: () => handlerError,
            close: () => new Promise(done => server.close(done))
        }));
    });
}

async function nodeRequest(route, options = {}) {
    return fetch(`${BASE_URL}${route}`, { redirect: "manual", ...options });
}

async function postJson(route, body, internal = false) {
    const headers = { "Content-Type": "application/json" };
    if (internal) headers["X-Internal-Token"] = TOKEN;
    const response = await nodeRequest(route, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(
        response.status, 200,
        `${route}: HTTP ${response.status} ${JSON.stringify(data)}`
    );
    return data;
}

async function emitResult({ seq, winner, p1, p2, b1, b2 }) {
    const child = spawn(process.env.PYTHON_BIN || "python", [
        emitterPath,
        "--node-url", `${BASE_URL}/receber-sinal`,
        "--token", TOKEN,
        "--session", SESSION,
        "--seq", String(seq),
        "--winner", winner,
        "--p1", String(p1),
        "--p2", String(p2),
        "--b1", String(b1),
        "--b2", String(b2)
    ], {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
        const text = String(chunk);
        stdout += text;
        process.stdout.write(text);
    });
    child.stderr.on("data", chunk => {
        const text = String(chunk);
        stderr += text;
        process.stderr.write(text);
    });

    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });

    assert.equal(code, 0, `Emissor Python falhou: ${stdout}\n${stderr}`);
    assert.match(stdout, new RegExp(`CONTROLLED_RESULT_SENT.*seq=${seq}\\b`));
}

async function main() {
    let db = null;
    const fakeExecutor = await startFakeExecutor(() => db);
    const backend = spawn(process.execPath, [backendPath], {
        cwd: path.join(__dirname, ".."),
        env: {
            ...process.env,
            DB_HOST: "127.0.0.1",
            DB_PORT: "3306",
            DB_USER: "root",
            DB_PASSWORD,
            DB_NAME: "bacbo_e2e",
            NODE_HOST: HOST,
            NODE_PORT: String(NODE_PORT),
            EXECUTOR_URL: `http://${HOST}:${EXECUTOR_PORT}/apostar`,
            INTERNAL_API_TOKEN: TOKEN,
            ADMIN_USERNAME: "",
            ADMIN_PASSWORD: "",
            BALANCE_SYNC_MAX_AGE_SECONDS: "90",
            LOG_FILE_ENABLED: "false",
            EXECUTOR_EXECUTION_TIMEOUT_MS: "5000"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    for (const [stream, output] of [
        [backend.stdout, process.stdout],
        [backend.stderr, process.stderr]
    ]) {
        stream.on("data", chunk => {
            const text = String(chunk);
            backendOutput += text;
            output.write(text);
        });
    }

    try {
        await waitUntil("backendPronto=true", async () => {
            if (backend.exitCode !== null) {
                throw new Error(`Backend encerrou (exit=${backend.exitCode})`);
            }
            try {
                return (await nodeRequest("/api/dashboard-stats")).status === 200;
            } catch {
                return false;
            }
        }, 30000);

        db = await mysql.createConnection({
            host: "127.0.0.1",
            port: 3306,
            user: "root",
            password: DB_PASSWORD,
            database: "bacbo_e2e"
        });

        assert.deepEqual(
            await postJson(
                "/receber-sinal",
                { saldo_atual: 1000, timestamp_coleta: Date.now() },
                true
            ),
            { recebido: true, saldo_atual: 1000 }
        );

        assert.deepEqual(
            await postJson("/api/novo-padrao", {
                nome: "OBS-003H E2E Pattern",
                origem: "OBS003H",
                padrao: "Player",
                entrada: "Banker",
                gales: 0,
                protegerEmpate: true,
                ativo: true
            }),
            { sucesso: true }
        );

        const [[strategy]] = await db.query(
            "SELECT id, origem, padrao, entrada, gales, proteger_empate, ativo FROM estrategias WHERE nome=? LIMIT 1",
            ["OBS-003H E2E Pattern"]
        );
        assert.ok(strategy);
        assert.equal(strategy.origem, "OBS003H");
        assert.equal(strategy.entrada, "Banker");
        assert.equal(Number(strategy.gales), 0);
        assert.equal(Number(strategy.proteger_empate), 1);
        assert.equal(Number(strategy.ativo), 1);
        assert.deepEqual(JSON.parse(strategy.padrao), ["Player"]);

        assert.deepEqual(
            await postJson("/api/auto-trader", {
                nome: "OBS-003H Trader",
                ativo: true,
                config: {
                    stake_inicial: 10,
                    gale_1_mult: 2,
                    gale_2_mult: 4,
                    tie_stake_mode: "VALOR",
                    tie_stake_value: 5,
                    tie_stake_percent: 0,
                    modo_camuflagem: "TODAS",
                    limite_entradas: 5,
                    stop_win: 500,
                    stop_loss: 500,
                    trailing_stop: false,
                    stop_reds_seguidos: 0,
                    hora_inicio: "00:00",
                    hora_fim: "23:59",
                    fontes_sinal: ["OBS003H"]
                }
            }),
            { sucesso: true, saldo_inicial: 1000 }
        );

        const [[trader]] = await db.query(
            "SELECT id, ativo, status_operacao, saldo_inicial, entradas_feitas FROM auto_traders WHERE nome=? LIMIT 1",
            ["OBS-003H Trader"]
        );
        assert.ok(trader);
        assert.equal(Number(trader.ativo), 1);
        assert.equal(trader.status_operacao, "STANDBY");
        assert.equal(Number(trader.saldo_inicial), 1000);
        assert.equal(Number(trader.entradas_feitas), 0);

        await emitResult({
            seq: 1, winner: "PlayerWon",
            p1: 4, p2: 3, b1: 2, b2: 1
        });

        // Não espera executor/auditoria. Seq2 chega enquanto seq1 ainda está bloqueada
        // no delay do callback EXECUTADA. Sem BUG-014C, seq2 pode ultrapassar seq1.
        await emitResult({
            seq: 2, winner: "BankerWon",
            p1: 1, p2: 2, b1: 4, b2: 3
        });

        await waitUntil("ordem no executor fake", () => {
            if (fakeExecutor.getError()) throw fakeExecutor.getError();
            return fakeExecutor.orders.length === 1;
        });

        const order = fakeExecutor.orders[0];
        assert.equal(order.token, TOKEN);
        assert.equal(order.apostas.length, 2);
        assert.deepEqual(order.apostas, [
            { alvo: "BankerWon", valor: 10 },
            { alvo: "Tie", valor: 5 }
        ]);
        assert.equal(order.payload.alvo, undefined);
        assert.equal(order.payload.valor, undefined);
        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");
        assert.ok(order.intentIdBeforeAck > 0);
        assert.equal(order.callbackBeforeAck, true);
        assert.equal(order.callbackDelayMs, 700);

        const finalized = await waitUntil("auditoria WIN apos rodadas sobrepostas", async () => {
            const [[row]] = await db.query(
                `SELECT id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,
                        valor_entrada, valor_empate, executor_order_id, executor_confirmacao_metodo,
                        executor_saldo_antes, executor_saldo_depois, executor_debito_observado,
                        execucao_confirmada_em, status_ordem, lucro_prejuizo, placar_mesa
                 FROM auditoria_ordens
                 WHERE trader_id=?
                 ORDER BY id DESC LIMIT 1`,
                [trader.id]
            );
            return row && row.status_ordem === "WIN" ? row : null;
        });

        assert.equal(finalized.estrategia_nome, "OBS-003H E2E Pattern");
        assert.equal(finalized.fonte_sinal, "OBS003H");
        assert.equal(finalized.alvo, "BankerWon");
        assert.equal(finalized.nivel, "DIRETO");
        assert.equal(Number(finalized.risco_total), 15);
        assert.equal(Number(finalized.valor_entrada), 10);
        assert.equal(Number(finalized.valor_empate), 5);
        assert.equal(finalized.executor_order_id, order.payload.order_id);
        assert.equal(finalized.executor_confirmacao_metodo, "SALDO_DEBITADO");
        assert.equal(Number(finalized.executor_saldo_antes), 1000);
        assert.equal(Number(finalized.executor_saldo_depois), 985);
        assert.equal(Number(finalized.executor_debito_observado), 15);
        assert.ok(Number(finalized.execucao_confirmada_em) > 0);
        assert.equal(Number(finalized.lucro_prejuizo), 5);
        assert.equal(finalized.placar_mesa, "[P:3 B:7]");

        const [[traderOperating]] = await db.query(
            "SELECT status_operacao, entradas_feitas FROM auto_traders WHERE id=?",
            [trader.id]
        );
        assert.equal(traderOperating.status_operacao, "OPERANDO");
        assert.equal(Number(traderOperating.entradas_feitas), 1);

        const [[history]] = await db.query(
            `SELECT tipo_resultado, nivel, multiplicador
             FROM historico_resultados
             WHERE estrategia_id=?
             ORDER BY id DESC LIMIT 1`,
            [strategy.id]
        );
        assert.ok(history);
        assert.deepEqual(
            {
                tipo_resultado: history.tipo_resultado,
                nivel: history.nivel,
                multiplicador: history.multiplicador
            },
            { tipo_resultado: "GREEN", nivel: "DIRETO", multiplicador: "" }
        );

        const [[spinCount]] = await db.query(
            "SELECT COUNT(*) AS total FROM giros_recentes"
        );
        const [[historyCount]] = await db.query(
            "SELECT COUNT(*) AS total FROM historico_resultados WHERE estrategia_id=?",
            [strategy.id]
        );
        const [[pendingCount]] = await db.query(
            "SELECT COUNT(*) AS total FROM auditoria_ordens WHERE status_ordem='PENDENTE'"
        );

        assert.equal(Number(spinCount.total), 2);
        assert.equal(Number(historyCount.total), 1);
        assert.equal(Number(pendingCount.total), 0);
        assert.equal(fakeExecutor.orders.length, 1);
        assert.equal(fakeExecutor.getError(), null);

        console.log("OBS-003H controlled E2E smoke: PASS");
    } catch (error) {
        console.error("OBS-003H controlled E2E smoke: FAIL", error);
        console.error("--- Saida acumulada do backend ---");
        console.error(backendOutput);
        process.exitCode = 1;
    } finally {
        if (db) {
            try { await db.end(); } catch {}
        }
        if (backend.exitCode === null) {
            backend.kill("SIGTERM");
            await Promise.race([
                new Promise(resolve => backend.once("exit", resolve)),
                sleep(3000)
            ]);
            if (backend.exitCode === null) backend.kill("SIGKILL");
        }
        try { await fakeExecutor.close(); } catch {}
    }
}

main().catch(error => {
    console.error("OBS-003H controlled E2E smoke: FAIL fatal", error);
    process.exitCode = 1;
});
