from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


backend = ROOT / "robo-bacbo" / "bot2_coletor.js"
e2e = ROOT / "robo-bacbo" / "integration" / "controlled-e2e-smoke.js"
current_state = ROOT / "docs" / "CURRENT_STATE.md"
known_issues = ROOT / "docs" / "KNOWN_ISSUES.md"
handoff = ROOT / "docs" / "GEMINI_HANDOFF.md"
changelog = ROOT / "CHANGELOG.md"
order_intent_test = ROOT / "robo-bacbo" / "test" / "order-intent.test.js"

# 1) Classificação explícita de falha definitiva x ambígua no transporte para o executor.
replace_once(
    backend,
    """            ultimoErro = timeout\n                ? new Error(`Timeout de ${EXECUTOR_TIMEOUT_MS}ms aguardando confirmacao da ordem ${orderId}`)\n                : e;\n\n            if (erroRepetivel && tentativa < EXECUTOR_MAX_ATTEMPTS) {\n""",
    """            ultimoErro = timeout\n                ? new Error(`Timeout de ${EXECUTOR_TIMEOUT_MS}ms aguardando confirmacao da ordem ${orderId}`)\n                : e;\n            ultimoErro.envio_ambiguo = erroRepetivel;\n\n            if (erroRepetivel && tentativa < EXECUTOR_MAX_ATTEMPTS) {\n""",
    "classificacao de falha do executor"
)

# 2) Helpers de intenção durável. PREPARANDO existe antes de qualquer efeito externo.
replace_once(
    backend,
    """    throw ultimoErro || new Error(`Falha desconhecida ao enviar ordem ${orderId}`);\n}\nif (!hostNodeEhLoopback(NODE_HOST)) {\n""",
    """    throw ultimoErro || new Error(`Falha desconhecida ao enviar ordem ${orderId}`);\n}\n\nfunction classificarStatusFalhaEnvioExecutor(erro) {\n    return erro && erro.envio_ambiguo === true ? 'ENVIO_AMBIGUO' : 'FALHA_ENVIO';\n}\n\nasync function criarIntencaoOrdem(queryable, dados) {\n    const orderId = String(dados.order_id || crypto.randomUUID());\n    const [resultado] = await queryable.query(\n        `INSERT INTO auditoria_ordens\n            (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,\n             valor_entrada, executor_order_id, status_ordem)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')`,\n        [\n            dados.trader_id,\n            dados.estrategia_nome,\n            dados.fonte_sinal,\n            dados.alvo,\n            dados.nivel,\n            dados.risco_total,\n            dados.valor_entrada,\n            orderId\n        ]\n    );\n\n    const auditoriaId = Number(resultado.insertId);\n    if (!Number.isInteger(auditoriaId) || auditoriaId <= 0) {\n        throw new Error('MySQL nao retornou ID valido para a intencao de ordem');\n    }\n\n    return { auditoria_id: auditoriaId, order_id: orderId };\n}\n\nasync function marcarIntencaoAposFalhaEnvio(auditoriaId, erro, contexto) {\n    const status = classificarStatusFalhaEnvioExecutor(erro);\n    try {\n        const [resultado] = await dbPool.query(\n            `UPDATE auditoria_ordens\n             SET status_ordem=?\n             WHERE id=? AND status_ordem='PREPARANDO'`,\n            [status, auditoriaId]\n        );\n        if (Number(resultado.affectedRows) !== 1) {\n            console.error(`⚠️ ${contexto}: intenção ${auditoriaId} não estava PREPARANDO ao registrar ${status}.`);\n        }\n    } catch (persistenciaErro) {\n        console.error(\n            `⚠️ ${contexto}: falha ao persistir ${status} na intenção ${auditoriaId}; `\n            + `PREPARANDO permanece como evidência conservadora:`,\n            persistenciaErro.message\n        );\n    }\n    return status;\n}\n\nif (!hostNodeEhLoopback(NODE_HOST)) {\n""",
    "helpers de intenção durável"
)

# 3) GALE: LOSS anterior + nova intenção PREPARANDO são transacionais e precedem o POST externo.
old_gale = """                                        try {\n                                            await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [-riscoAntigo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);\n                                        } catch(e) {\n                                            console.error(`⚠️ Falha ao encerrar ordem anterior antes do GALE ${st.galeAtual} do trader ${trader.id}:`, e.message);\n                                        }\n\n                                        let executorConfirmouGale = false;\n                                        let ordemExecutorIdGale = null;\n                                        try {\n                                            const confirmacaoExecutor = await enviarOrdemAoExecutor(alvoPython, valorGale);\n                                            executorConfirmouGale = true;\n                                            ordemExecutorIdGale = confirmacaoExecutor.dados.order_id;\n                                            await dbPool.query(`INSERT INTO auditoria_ordens (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total, valor_entrada, executor_order_id, status_ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`, [trader.id, est.nome, est.origem, alvoPython, `GALE ${st.galeAtual}`, riscoAntigo + valorGale, valorGale, ordemExecutorIdGale]);\n                                        } catch(e) {\n                                            if (executorConfirmouGale) {\n                                                console.error(`⚠️ GALE ${st.galeAtual} confirmado pelo executor (${ordemExecutorIdGale}), mas nao registrado na auditoria do trader ${trader.id}:`, e.message);\n                                            } else {\n                                                console.error(`❌ GALE ${st.galeAtual} nao enviado para o trader ${trader.id}:`, e.message);\n                                            }\n                                        }\n"""
new_gale = """                                        const ordemExecutorIdGale = crypto.randomUUID();\n                                        let intencaoGale = null;\n                                        let conexaoGale = null;\n                                        try {\n                                            conexaoGale = await dbPool.getConnection();\n                                            await conexaoGale.beginTransaction();\n                                            await conexaoGale.query(\n                                                `UPDATE auditoria_ordens\n                                                 SET status_ordem='LOSS', lucro_prejuizo=?, saldo_pos=?, placar_mesa=?\n                                                 WHERE id=?`,\n                                                [-riscoAntigo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]\n                                            );\n                                            intencaoGale = await criarIntencaoOrdem(conexaoGale, {\n                                                trader_id: trader.id,\n                                                estrategia_nome: est.nome,\n                                                fonte_sinal: est.origem,\n                                                alvo: alvoPython,\n                                                nivel: `GALE ${st.galeAtual}`,\n                                                risco_total: riscoAntigo + valorGale,\n                                                valor_entrada: valorGale,\n                                                order_id: ordemExecutorIdGale\n                                            });\n                                            await conexaoGale.commit();\n                                        } catch(e) {\n                                            if (conexaoGale) {\n                                                try { await conexaoGale.rollback(); } catch(rollbackError) {\n                                                    console.error(`❌ Rollback falhou ao preparar GALE ${st.galeAtual} do trader ${trader.id}:`, rollbackError.message);\n                                                }\n                                            }\n                                            console.error(\n                                                `❌ GALE ${st.galeAtual} do trader ${trader.id} bloqueado: `\n                                                + `falha ao persistir LOSS anterior + intenção PREPARANDO antes do executor:`,\n                                                e.message\n                                            );\n                                            continue;\n                                        } finally {\n                                            if (conexaoGale) conexaoGale.release();\n                                        }\n\n                                        let executorConfirmouGale = false;\n                                        try {\n                                            await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale);\n                                            executorConfirmouGale = true;\n                                            const [auditoriaAtualizada] = await dbPool.query(\n                                                `UPDATE auditoria_ordens\n                                                 SET status_ordem='PENDENTE'\n                                                 WHERE id=? AND executor_order_id=? AND status_ordem='PREPARANDO'`,\n                                                [intencaoGale.auditoria_id, ordemExecutorIdGale]\n                                            );\n                                            if (Number(auditoriaAtualizada.affectedRows) !== 1) {\n                                                throw new Error('Intenção PREPARANDO do GALE não encontrada após ACK do executor');\n                                            }\n                                        } catch(e) {\n                                            if (executorConfirmouGale) {\n                                                console.error(\n                                                    `⚠️ GALE ${st.galeAtual} confirmado pelo executor (${ordemExecutorIdGale}), `\n                                                    + `mas a intenção ${intencaoGale.auditoria_id} não avançou para PENDENTE; `\n                                                    + `PREPARANDO foi preservado para reconciliação:`,\n                                                    e.message\n                                                );\n                                            } else {\n                                                const statusFalha = await marcarIntencaoAposFalhaEnvio(\n                                                    intencaoGale.auditoria_id,\n                                                    e,\n                                                    `GALE ${st.galeAtual} do trader ${trader.id}`\n                                                );\n                                                console.error(\n                                                    `❌ GALE ${st.galeAtual} não confirmado para o trader ${trader.id}; `\n                                                    + `intenção ${intencaoGale.auditoria_id} marcada ${statusFalha}:`,\n                                                    e.message\n                                                );\n                                            }\n                                        }\n"""
replace_once(backend, old_gale, new_gale, "fluxo GALE com intenção durável")

# 4) DIRETO: intenção PREPARANDO é persistida antes de enviar ao executor.
old_direct = """                                    let executorConfirmouDireto = false;\n                                    let ordemExecutorIdDireto = null;\n                                    try {\n                                        const confirmacaoExecutor = await enviarOrdemAoExecutor(alvoPython, valorArredondado);\n                                        executorConfirmouDireto = true;\n                                        ordemExecutorIdDireto = confirmacaoExecutor.dados.order_id;\n\n                                        const conexao = await dbPool.getConnection();\n                                        try {\n                                            await conexao.beginTransaction();\n                                            const novasEntradas = trader.entradas_feitas + 1;\n                                            await conexao.query('UPDATE auto_traders SET entradas_feitas=? WHERE id=?', [novasEntradas, trader.id]);\n                                            await conexao.query(`INSERT INTO auditoria_ordens (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total, valor_entrada, executor_order_id, status_ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`, [trader.id, est.nome, est.origem, alvoPython, 'DIRETO', valorArredondado, valorArredondado, ordemExecutorIdDireto]);\n                                            await conexao.commit();\n                                            trader.entradas_feitas = novasEntradas;\n                                        } catch(e) {\n                                            try { await conexao.rollback(); } catch(rollbackError) { console.error(`❌ Rollback falhou para o trader ${trader.id}:`, rollbackError.message); }\n                                            throw e;\n                                        } finally {\n                                            conexao.release();\n                                        }\n                                    } catch(e) {\n                                        if (executorConfirmouDireto) {\n                                            console.error(`⚠️ Ordem DIRETO confirmada pelo executor (${ordemExecutorIdDireto}), mas nao registrada para o trader ${trader.id}:`, e.message);\n                                        } else {\n                                            console.error(`❌ Ordem DIRETO nao enviada para o trader ${trader.id}:`, e.message);\n                                        }\n                                    }\n"""
new_direct = """                                    const ordemExecutorIdDireto = crypto.randomUUID();\n                                    let intencaoDireto = null;\n                                    try {\n                                        intencaoDireto = await criarIntencaoOrdem(dbPool, {\n                                            trader_id: trader.id,\n                                            estrategia_nome: est.nome,\n                                            fonte_sinal: est.origem,\n                                            alvo: alvoPython,\n                                            nivel: 'DIRETO',\n                                            risco_total: valorArredondado,\n                                            valor_entrada: valorArredondado,\n                                            order_id: ordemExecutorIdDireto\n                                        });\n                                    } catch(e) {\n                                        console.error(\n                                            `❌ Ordem DIRETO do trader ${trader.id} bloqueada: `\n                                            + `falha ao persistir intenção PREPARANDO antes do executor:`,\n                                            e.message\n                                        );\n                                        continue;\n                                    }\n\n                                    let executorConfirmouDireto = false;\n                                    try {\n                                        await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto);\n                                        executorConfirmouDireto = true;\n\n                                        const conexao = await dbPool.getConnection();\n                                        try {\n                                            await conexao.beginTransaction();\n                                            const novasEntradas = trader.entradas_feitas + 1;\n                                            await conexao.query('UPDATE auto_traders SET entradas_feitas=? WHERE id=?', [novasEntradas, trader.id]);\n                                            const [auditoriaAtualizada] = await conexao.query(\n                                                `UPDATE auditoria_ordens\n                                                 SET status_ordem='PENDENTE'\n                                                 WHERE id=? AND executor_order_id=? AND status_ordem='PREPARANDO'`,\n                                                [intencaoDireto.auditoria_id, ordemExecutorIdDireto]\n                                            );\n                                            if (Number(auditoriaAtualizada.affectedRows) !== 1) {\n                                                throw new Error('Intenção PREPARANDO DIRETO não encontrada após ACK do executor');\n                                            }\n                                            await conexao.commit();\n                                            trader.entradas_feitas = novasEntradas;\n                                        } catch(e) {\n                                            try { await conexao.rollback(); } catch(rollbackError) { console.error(`❌ Rollback falhou para o trader ${trader.id}:`, rollbackError.message); }\n                                            throw e;\n                                        } finally {\n                                            conexao.release();\n                                        }\n                                    } catch(e) {\n                                        if (executorConfirmouDireto) {\n                                            console.error(\n                                                `⚠️ Ordem DIRETO confirmada pelo executor (${ordemExecutorIdDireto}), `\n                                                + `mas a intenção ${intencaoDireto.auditoria_id} não avançou para PENDENTE; `\n                                                + `PREPARANDO foi preservado para reconciliação:`,\n                                                e.message\n                                            );\n                                        } else {\n                                            const statusFalha = await marcarIntencaoAposFalhaEnvio(\n                                                intencaoDireto.auditoria_id,\n                                                e,\n                                                `DIRETO do trader ${trader.id}`\n                                            );\n                                            console.error(\n                                                `❌ Ordem DIRETO não confirmada para o trader ${trader.id}; `\n                                                + `intenção ${intencaoDireto.auditoria_id} marcada ${statusFalha}:`,\n                                                e.message\n                                            );\n                                        }\n                                    }\n"""
replace_once(backend, old_direct, new_direct, "fluxo DIRETO com intenção durável")

# 5) E2E: o executor fake só dá ACK depois de comprovar PREPARANDO no MySQL.
replace_once(
    e2e,
    """function startFakeExecutor() {\n    const orders = [];\n    let handlerError = null;\n""",
    """function startFakeExecutor(getDb) {\n    const orders = [];\n    let handlerError = null;\n""",
    "assinatura do executor fake"
)
replace_once(
    e2e,
    """        req.on(\"end\", () => {\n            try {\n""",
    """        req.on(\"end\", async () => {\n            try {\n""",
    "handler async do executor fake"
)
replace_once(
    e2e,
    """                assert.ok(Number(payload.valor) > 0);\n\n                orders.push({ payload, token: req.headers[\"x-internal-token\"] });\n                res.writeHead(200, { \"Content-Type\": \"application/json\" });\n""",
    """                assert.ok(Number(payload.valor) > 0);\n\n                const db = getDb();\n                assert.ok(db, \"Conexão MySQL do teste deve existir antes da primeira ordem\");\n                const [[intent]] = await db.query(\n                    `SELECT id, trader_id, alvo, nivel, valor_entrada, executor_order_id, status_ordem\n                     FROM auditoria_ordens\n                     WHERE executor_order_id=?\n                     ORDER BY id DESC LIMIT 1`,\n                    [payload.order_id]\n                );\n                assert.ok(intent, \"Intenção durável deve existir antes do ACK do executor\");\n                assert.equal(intent.status_ordem, \"PREPARANDO\");\n                assert.equal(intent.alvo, payload.alvo);\n                assert.equal(Number(intent.valor_entrada), Number(payload.valor));\n\n                orders.push({\n                    payload,\n                    token: req.headers[\"x-internal-token\"],\n                    intentStatusBeforeAck: intent.status_ordem,\n                    intentIdBeforeAck: Number(intent.id)\n                });\n                res.writeHead(200, { \"Content-Type\": \"application/json\" });\n""",
    "assert PREPARANDO antes do ACK"
)
replace_once(
    e2e,
    """async function main() {\n    const fakeExecutor = await startFakeExecutor();\n    const backend = spawn(process.execPath, [backendPath], {\n""",
    """async function main() {\n    let db = null;\n    const fakeExecutor = await startFakeExecutor(() => db);\n    const backend = spawn(process.execPath, [backendPath], {\n""",
    "db disponível ao executor fake"
)
replace_once(
    e2e,
    """    let db = null;\n    try {\n""",
    """    try {\n""",
    "remoção de declaração duplicada db"
)
replace_once(
    e2e,
    """        assert.equal(order.payload.alvo, \"BankerWon\");\n        assert.equal(Number(order.payload.valor), 10);\n\n        const pending = await waitUntil(\"auditoria PENDENTE\", async () => {\n""",
    """        assert.equal(order.payload.alvo, \"BankerWon\");\n        assert.equal(Number(order.payload.valor), 10);\n        assert.equal(order.intentStatusBeforeAck, \"PREPARANDO\");\n        assert.ok(order.intentIdBeforeAck > 0);\n\n        const pending = await waitUntil(\"auditoria PENDENTE\", async () => {\n""",
    "assert final do PREPARANDO"
)

# 6) Testes Node focados no novo contrato de falha e na ordem PREPARANDO -> executor.
order_intent_test.write_text(r'''"use strict";

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
''', encoding="utf-8")

# 7) Documentação do estado arquitetural e risco residual.
replace_once(
    current_state,
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-013, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014A, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "cabeçalho CURRENT_STATE"
)
replace_once(
    current_state,
    """- ordens Node→Python usam `order_id` UUID; o executor persiste os últimos IDs aceitos em journal atômico e mantém a deduplicação através de restart;\n- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;\n- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta.\n""",
    """- ordens Node→Python usam `order_id` UUID; o executor persiste os últimos IDs aceitos em journal atômico e mantém a deduplicação através de restart;\n- antes de qualquer POST financeiro ao executor, o Node persiste uma intenção `PREPARANDO` em `auditoria_ordens` com o mesmo `order_id`; DIRETO só incrementa `entradas_feitas` quando o ACK transforma essa intenção em `PENDENTE`;\n- no GALE, o `LOSS` da ordem anterior e a intenção `PREPARANDO` da próxima exposição são gravados na mesma transação antes do POST externo;\n- rejeição definitiva do executor marca a intenção `FALHA_ENVIO`; timeout, erro de transporte, 5xx ou confirmação inválida após os retries marcam `ENVIO_AMBIGUO`; ACK seguido de falha de finalização MySQL preserva `PREPARANDO` para não apagar a evidência de uma ordem externamente aceita;\n- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;\n- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta.\n""",
    "Auto-Trader CURRENT_STATE"
)
replace_once(
    current_state,
    "- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado para validar captura/sequência → matching de padrão → `STANDBY`→`OPERANDO` → ordem DIRETO com UUID → auditoria `PENDENTE` → segunda rodada → `WIN` + `historico_resultados=GREEN/DIRETO`;",
    "- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; o fake só responde ao POST depois de consultar o MySQL e comprovar que o mesmo `order_id` já existe como `PREPARANDO`, então o fluxo segue para `PENDENTE` e depois `WIN` + `historico_resultados=GREEN/DIRETO`;",
    "E2E CURRENT_STATE"
)
replace_once(
    current_state,
    """- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright deixa o efeito externo ambíguo; IDs já persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;\n""",
    """- a intenção financeira agora é durável antes do POST externo, mas o ACK atual de `/apostar` ainda significa aceite na fila do executor, não confirmação de clique efetivo no DOM; timeout/5xx ficam registrados como `ENVIO_AMBIGUO` e ACK sem finalização MySQL preserva `PREPARANDO`;\n- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright deixa o efeito externo ambíguo; IDs já persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;\n- o executor ainda pode aceitar uma ordem enquanto o Playwright não está pronto e a fila ainda não possui TTL; confirmação real de execução, readiness e expiração de ordem pertencem ao próximo patch do lifecycle, não ao BUG-014A;\n- o processamento pós-ACK de `/receber-sinal` ainda não é serializado explicitamente; essa concorrência deve ser tratada separadamente para não misturar protocolo Node↔Python com ordenação das rodadas;\n""",
    "riscos CURRENT_STATE"
)

insert_bug014 = """### BUG-014 — Lifecycle da ordem entre intenção, aceite e execução\n\nStatus: **BUG-014A mitigou a janela sem auditoria durável; confirmação efetiva do executor e serialização de rodadas ainda pendentes**.\n\nAntes do BUG-014A, DIRETO e GALE podiam chegar ao executor antes de existir a linha correspondente em `auditoria_ordens`. Se o efeito externo fosse aceito e o MySQL falhasse logo depois, a exposição poderia existir sem uma intenção durável local.\n\nAgora o Node cria `PREPARANDO` com `executor_order_id`, trader, estratégia, alvo, nível, risco e valor antes de qualquer `POST /apostar`. No DIRETO, `entradas_feitas` continua aumentando somente depois do ACK e da transição da mesma linha para `PENDENTE`. No GALE, o `LOSS` anterior e a nova intenção são atômicos antes do envio. Rejeições definitivas viram `FALHA_ENVIO`; falhas ambíguas de transporte/timeout/5xx/confirmação inválida viram `ENVIO_AMBIGUO`. Se o executor já confirmou e a finalização no banco falhar, `PREPARANDO` é preservado como estado conservador para futura reconciliação.\n\nRiscos residuais: `/apostar` ainda confirma entrada na fila, não execução real dos cliques; o executor ainda não expõe readiness nem TTL de ordem; e o processamento pós-ACK de `/receber-sinal` ainda pode se sobrepor. Esses pontos devem ser corrigidos em patches separados para preservar rollback isolado e não fingir garantia de exactly-once do efeito externo.\n\n"""
replace_once(
    known_issues,
    "### BUG-001R — Restart do executor e exactly-once do efeito externo\n",
    insert_bug014 + "### BUG-001R — Restart do executor e exactly-once do efeito externo\n",
    "BUG-014 KNOWN_ISSUES"
)
replace_once(
    known_issues,
    "- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: `processar_resultado` real gera sequência/coleta, uma estratégia real casa o padrão, o Auto-Trader sai de `STANDBY`, a ordem DIRETO é confirmada com o mesmo `order_id`, a auditoria passa de `PENDENTE` para `WIN` e `historico_resultados` registra `GREEN/DIRETO`;",
    "- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: antes de responder ao POST, o executor fake comprova no banco a intenção `PREPARANDO` com o mesmo `order_id`; depois o backend promove a linha para `PENDENTE`, fecha em `WIN` e registra `historico_resultados=GREEN/DIRETO`;",
    "E2E KNOWN_ISSUES"
)

replace_once(
    handoff,
    "- deduplicação de `order_id` persistida em journal local atômico, sobrevivendo a restart do executor e falhando fechado com journal inválido/indisponível;",
    "- deduplicação de `order_id` persistida em journal local atômico, sobrevivendo a restart do executor e falhando fechado com journal inválido/indisponível;\n- BUG-014A: toda ordem DIRETO/GALE recebe intenção durável `PREPARANDO` no MySQL antes do POST ao executor; falha definitiva vira `FALHA_ENVIO`, falha ambígua vira `ENVIO_AMBIGUO` e ACK sem finalização de banco preserva `PREPARANDO`;",
    "estado GEMINI_HANDOFF"
)
replace_once(
    handoff,
    """- deduplicação do `order_id` sobrevive a restart, mas um crash exatamente durante o clique Playwright mantém ambiguidade sobre o efeito externo; IDs já persistidos não são reenfileirados automaticamente para priorizar prevenção de duplicidade;\n""",
    """- BUG-014A garante intenção MySQL antes do efeito externo, mas `/apostar` ainda confirma fila, não clique efetivo; o próximo passo prioritário é lifecycle explícito no executor com readiness, TTL e estados de execução, sem afirmar exactly-once absoluto;\n- deduplicação do `order_id` sobrevive a restart, mas um crash exatamente durante o clique Playwright mantém ambiguidade sobre o efeito externo; IDs já persistidos não são reenfileirados automaticamente para priorizar prevenção de duplicidade;\n- `/receber-sinal` ainda responde antes de concluir o processamento e não possui serialização explícita do pós-ACK; tratar esse risco em patch separado do protocolo do executor;\n""",
    "riscos GEMINI_HANDOFF"
)
replace_once(
    handoff,
    """- o E2E deve permanecer totalmente controlado, usando executor fake autenticado e MySQL descartável;\n- nunca apontar esse job para site, executor ou conta real.\n""",
    """- o E2E deve permanecer totalmente controlado, usando executor fake autenticado e MySQL descartável;\n- quando tocar criação/envio de ordens, o executor fake deve comprovar que a intenção `PREPARANDO` com o mesmo `order_id` já está visível no MySQL antes de devolver ACK;\n- nunca apontar esse job para site, executor ou conta real.\n""",
    "validação GEMINI_HANDOFF"
)

replace_once(
    changelog,
    "- BUG-001B: cada ordem Node→Python recebe `order_id` UUID; falhas ambíguas são repetidas uma vez com o mesmo ID e o executor responde idempotentemente sem duplicar a fila.\n",
    "- BUG-001B: cada ordem Node→Python recebe `order_id` UUID; falhas ambíguas são repetidas uma vez com o mesmo ID e o executor responde idempotentemente sem duplicar a fila.\n- BUG-014A: DIRETO e GALE passam a persistir uma intenção `PREPARANDO` em `auditoria_ordens` com o mesmo `order_id` antes de qualquer POST ao executor; rejeição definitiva vira `FALHA_ENVIO`, falha ambígua vira `ENVIO_AMBIGUO` e ACK seguido de falha de finalização preserva `PREPARANDO` para reconciliação.\n- No GALE, o encerramento `LOSS` da exposição anterior e a criação da nova intenção são transacionais antes do efeito externo; no DIRETO, `entradas_feitas` continua sendo incrementado somente após ACK e promoção da intenção para `PENDENTE`.\n",
    "CHANGELOG BUG-014A"
)

print("BUG-014A patch aplicado com sucesso")
