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
test_file = ROOT / "robo-bacbo" / "test" / "round-serialization.test.js"

# 1) Estado de admissão e fila FIFO independentes do estado processado.
replace_once(
    backend,
    """let estadoContinuidadeColetor = {\n    sessao: null,\n    seq: null,\n    timestamp_coleta: null\n};\nlet contadorGirosParaLimpeza = 0;\n""",
    """let estadoContinuidadeColetor = {\n    sessao: null,\n    seq: null,\n    timestamp_coleta: null\n};\n// BUG-014C: a admissão avança sincronamente no recebimento para que duas requisições\n// consecutivas nunca avaliem o mesmo estado enquanto a rodada anterior aguarda I/O.\nlet estadoContinuidadeRecepcao = {\n    sessao: null,\n    seq: null,\n    timestamp_coleta: null\n};\nlet caudaProcessamentoResultados = Promise.resolve();\nlet resultadosAguardandoProcessamento = 0;\n\nfunction aguardarTurnoProcessamentoResultado() {\n    resultadosAguardandoProcessamento++;\n    const turnoAnterior = caudaProcessamentoResultados;\n    let liberarProximo = null;\n    caudaProcessamentoResultados = new Promise(resolve => { liberarProximo = resolve; });\n\n    return turnoAnterior.then(() => {\n        let liberado = false;\n        return () => {\n            if (liberado) return false;\n            liberado = true;\n            resultadosAguardandoProcessamento = Math.max(0, resultadosAguardandoProcessamento - 1);\n            liberarProximo();\n            return true;\n        };\n    });\n}\n\nfunction reservarContinuidadeResultado(dados) {\n    const continuidade = avaliarContinuidadeResultado(estadoContinuidadeRecepcao, dados);\n    if (continuidade.aceitar) {\n        estadoContinuidadeRecepcao = { ...continuidade.estado };\n    }\n    return continuidade;\n}\n\nlet contadorGirosParaLimpeza = 0;\n""",
    "estado e fila FIFO"
)

# 2) O handler reserva a sequência antes de qualquer await e libera seu turno em finally.
replace_once(
    backend,
    """app.post(\"/receber-sinal\", async (req, res) => {\n    try {\n""",
    """app.post(\"/receber-sinal\", async (req, res) => {\n    let liberarTurnoResultado = null;\n    try {\n""",
    "declaração do release"
)
replace_once(
    backend,
    """        if (rawVenc.includes(\"PLAYER\") || rawVenc === \"P\" || rawVenc === \"AZUL\") vencedor = \"Player\";\n        else if (rawVenc.includes(\"BANKER\") || rawVenc === \"B\" || rawVenc === \"VERMELHO\") vencedor = \"Banker\";\n        else if (rawVenc.includes(\"TIE\") || rawVenc === \"T\" || rawVenc === \"EMPATE\") vencedor = \"Tie\";\n\n        const temSaldo = dados.saldo_atual !== undefined && dados.saldo_atual !== null;\n""",
    """        if (rawVenc.includes(\"PLAYER\") || rawVenc === \"P\" || rawVenc === \"AZUL\") vencedor = \"Player\";\n        else if (rawVenc.includes(\"BANKER\") || rawVenc === \"B\" || rawVenc === \"VERMELHO\") vencedor = \"Banker\";\n        else if (rawVenc.includes(\"TIE\") || rawVenc === \"T\" || rawVenc === \"EMPATE\") vencedor = \"Tie\";\n\n        // Reserva a continuidade antes de qualquer await (inclusive persistência de saldo).\n        // O processamento financeiro continua abaixo, serializado após o ACK.\n        const continuidade = vencedor ? reservarContinuidadeResultado(dados) : null;\n\n        const temSaldo = dados.saldo_atual !== undefined && dados.saldo_atual !== null;\n""",
    "reserva antes de I/O"
)
replace_once(
    backend,
    """        if (!vencedor) return res.json({ recebido: true, saldo_atual: saldoGlobalCorretora });\n\n        const continuidade = avaliarContinuidadeResultado(estadoContinuidadeColetor, dados);\n\n        if (!continuidade.aceitar) {\n""",
    """        if (!vencedor) return res.json({ recebido: true, saldo_atual: saldoGlobalCorretora });\n\n        if (!continuidade || !continuidade.aceitar) {\n""",
    "usa continuidade reservada"
)
replace_once(
    backend,
    """        res.json({ recebido: true });\n\n        if (continuidade.interrupcao) {\n""",
    """        res.json({ recebido: true });\n\n        // ACK continua rápido; somente o trabalho pós-ACK espera sua vez FIFO.\n        liberarTurnoResultado = await aguardarTurnoProcessamentoResultado();\n\n        if (continuidade.interrupcao) {\n""",
    "turno após ACK"
)
replace_once(
    backend,
    """    } catch(erroGeral) {\n        console.error('🔥 Falha no processamento de /receber-sinal após o ACK:', erroGeral);\n    }\n});\n""",
    """    } catch(erroGeral) {\n        console.error('🔥 Falha no processamento de /receber-sinal após o ACK:', erroGeral);\n    } finally {\n        if (liberarTurnoResultado) {\n            liberarTurnoResultado();\n        }\n    }\n});\n""",
    "liberação finally"
)

# 3) Teste unitário da fila e invariantes de ordenação no handler.
test_file.write_text(r'''"use strict";

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
    const finallyRelease = handler.indexOf("if (liberarTurnoResultado)");

    assert.ok(reserva >= 0 && primeiroAwaitSaldo > reserva, "reserva deve preceder o primeiro I/O possível");
    assert.ok(ack >= 0 && turno > ack, "ACK deve preceder espera FIFO");
    assert.ok(interrupcao > turno, "mutações pós-ACK devem ocorrer dentro do turno");
    assert.ok(finallyRelease > interrupcao, "turno deve ser liberado em finally");
});
''', encoding="utf-8")

# 4) E2E força sobreposição: seq2 chega enquanto seq1 aguarda executor.
replace_once(
    e2e,
    """function startFakeExecutor(getDb) {\n    const orders = [];\n    let handlerError = null;\n""",
    """function startFakeExecutor(getDb) {\n    const orders = [];\n    let handlerError = null;\n    const callbackDelayMs = 700;\n""",
    "delay fake executor"
)
replace_once(
    e2e,
    """                const callbackResponse = await fetch(`${BASE_URL}/executor-status`, {\n""",
    """                // Mantém a primeira rodada deliberadamente presa no executor.\n                // A segunda rodada será recebida pelo Node durante este intervalo.\n                await sleep(callbackDelayMs);\n\n                const callbackResponse = await fetch(`${BASE_URL}/executor-status`, {\n""",
    "delay antes callback"
)
replace_once(
    e2e,
    """                    callbackBeforeAck: true\n                });\n""",
    """                    callbackBeforeAck: true,\n                    callbackDelayMs\n                });\n""",
    "registra delay"
)

old_flow = r'''        await emitResult({
            seq: 1, winner: "PlayerWon",
            p1: 4, p2: 3, b1: 2, b2: 1
        });

        await waitUntil("ordem no executor fake", () => {
            if (fakeExecutor.getError()) throw fakeExecutor.getError();
            return fakeExecutor.orders.length === 1;
        });

        const order = fakeExecutor.orders[0];
        assert.equal(order.token, TOKEN);
        assert.equal(order.payload.alvo, "BankerWon");
        assert.equal(Number(order.payload.valor), 10);
        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");
        assert.ok(order.intentIdBeforeAck > 0);
        assert.equal(order.callbackBeforeAck, true);

        const pending = await waitUntil("auditoria PENDENTE", async () => {
            const [[row]] = await db.query(
                `SELECT id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,
                        valor_entrada, executor_order_id, status_ordem
                 FROM auditoria_ordens
                 WHERE trader_id=?
                 ORDER BY id DESC LIMIT 1`,
                [trader.id]
            );
            return row && row.status_ordem === "PENDENTE" ? row : null;
        });

        assert.equal(pending.estrategia_nome, "OBS-003H E2E Pattern");
        assert.equal(pending.fonte_sinal, "OBS003H");
        assert.equal(pending.alvo, "BankerWon");
        assert.equal(pending.nivel, "DIRETO");
        assert.equal(Number(pending.risco_total), 10);
        assert.equal(Number(pending.valor_entrada), 10);
        assert.equal(pending.executor_order_id, order.payload.order_id);

        const [[traderOperating]] = await db.query(
            "SELECT status_operacao, entradas_feitas FROM auto_traders WHERE id=?",
            [trader.id]
        );
        assert.equal(traderOperating.status_operacao, "OPERANDO");
        assert.equal(Number(traderOperating.entradas_feitas), 1);

        await emitResult({
            seq: 2, winner: "BankerWon",
            p1: 1, p2: 2, b1: 4, b2: 3
        });

        const finalized = await waitUntil("auditoria WIN", async () => {
            const [[row]] = await db.query(
                "SELECT status_ordem, lucro_prejuizo, placar_mesa FROM auditoria_ordens WHERE id=?",
                [pending.id]
            );
            return row && row.status_ordem !== "PENDENTE" ? row : null;
        });

        assert.equal(finalized.status_ordem, "WIN");
        assert.equal(Number(finalized.lucro_prejuizo), 10);
        assert.equal(finalized.placar_mesa, "[P:3 B:7]");
'''
new_flow = r'''        await emitResult({
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
        assert.equal(order.payload.alvo, "BankerWon");
        assert.equal(Number(order.payload.valor), 10);
        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");
        assert.ok(order.intentIdBeforeAck > 0);
        assert.equal(order.callbackBeforeAck, true);
        assert.equal(order.callbackDelayMs, 700);

        const finalized = await waitUntil("auditoria WIN apos rodadas sobrepostas", async () => {
            const [[row]] = await db.query(
                `SELECT id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,
                        valor_entrada, executor_order_id, status_ordem, lucro_prejuizo, placar_mesa
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
        assert.equal(Number(finalized.risco_total), 10);
        assert.equal(Number(finalized.valor_entrada), 10);
        assert.equal(finalized.executor_order_id, order.payload.order_id);
        assert.equal(Number(finalized.lucro_prejuizo), 10);
        assert.equal(finalized.placar_mesa, "[P:3 B:7]");

        const [[traderOperating]] = await db.query(
            "SELECT status_operacao, entradas_feitas FROM auto_traders WHERE id=?",
            [trader.id]
        );
        assert.equal(traderOperating.status_operacao, "OPERANDO");
        assert.equal(Number(traderOperating.entradas_feitas), 1);
'''
replace_once(e2e, old_flow, new_flow, "fluxo E2E concorrente")
replace_once(
    e2e,
    """                [pending.id]\n""",
    """                [finalized.id]\n""",
    "referência final audit"
) if False else None

# 5) Documentação.
replace_once(
    current_state,
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014B, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014C, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "header CURRENT_STATE"
)
replace_once(
    current_state,
    """- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta.\n""",
    """- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta;\n- resultados autenticados mantêm ACK HTTP rápido, mas reservam `coletor_sessao/coletor_seq` sincronamente antes de qualquer I/O e executam todo o trabalho pós-ACK em uma fila FIFO única; uma rodada não pode ultrapassar outra enquanto a anterior aguarda MySQL ou callback do executor.\n""",
    "fila CURRENT_STATE"
)
replace_once(
    current_state,
    """- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; o fake comprova `PREPARANDO`, envia callback `EXECUTADA` antes do próprio ACK de fila e só então responde ao POST, validando que o waiter do Node já existia e que a linha avança para `PENDENTE`/`WIN`;\n""",
    """- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; além de comprovar `PREPARANDO`/callback antecipado, o fake atrasa deliberadamente a execução enquanto a rodada seguinte já é enviada, validando que o FIFO pós-ACK preserva a ordem causal e ainda fecha a auditoria em `WIN`;\n""",
    "E2E CURRENT_STATE"
)
replace_once(
    current_state,
    """- o processamento pós-ACK de `/receber-sinal` ainda não é serializado explicitamente; essa concorrência deve ser tratada separadamente para não misturar protocolo Node↔Python com ordenação das rodadas;\n""",
    """,
    "remove risco serial CURRENT_STATE"
)

replace_once(
    known_issues,
    "Status: **BUG-014A/014B mitigaram intenção, readiness, TTL e confirmação local da tentativa DOM; serialização das rodadas Node ainda pendente**.",
    "Status: **mitigado pelos patches BUG-014A/014B/014C, sujeito à ambiguidade externa residual descrita abaixo**.",
    "status BUG014"
)
replace_once(
    known_issues,
    """Risco residual separado: `/receber-sinal` ainda responde antes de concluir todo o processamento da rodada e não possui serialização explícita do pós-ACK. Esse ponto deve ser tratado em BUG-014C sem misturar novamente o protocolo do executor.\n\n""",
    """O BUG-014C mantém o ACK rápido de `/receber-sinal`, mas separa admissão de sequência e processamento: `coletor_sessao/coletor_seq` são reservados sincronamente antes do primeiro `await`, e toda mutação pós-ACK entra em uma fila FIFO. Assim uma rodada recebida durante MySQL/callback da anterior aguarda sua vez e não pode fechar/criar sinais sobre estado intermediário.\n\n""",
    "BUG014C KNOWN_ISSUES"
)
replace_once(
    known_issues,
    """- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: antes de responder ao POST, o executor fake comprova no banco a intenção `PREPARANDO` com o mesmo `order_id`; depois o backend promove a linha para `PENDENTE`, fecha em `WIN` e registra `historico_resultados=GREEN/DIRETO`;\n""",
    """- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: o executor comprova `PREPARANDO`, atrasa o callback enquanto a rodada seguinte já chega ao Node e valida que a fila FIFO impede ultrapassagem; depois a mesma auditoria fecha em `WIN` e `historico_resultados` registra `GREEN/DIRETO`;\n""",
    "E2E KNOWN_ISSUES"
)

replace_once(
    handoff,
    "- BUG-014B: novas ordens só são aceitas com Playwright pronto, possuem TTL de fila e exigem callback autenticado `EXECUTADA/FALHOU/EXPIRADA/AMBIGUA`; Node só promove `PREPARANDO` após `EXECUTADA`, e callback antecipado é suportado;",
    "- BUG-014B: novas ordens só são aceitas com Playwright pronto, possuem TTL de fila e exigem callback autenticado `EXECUTADA/FALHOU/EXPIRADA/AMBIGUA`; Node só promove `PREPARANDO` após `EXECUTADA`, e callback antecipado é suportado;\n- BUG-014C: `/receber-sinal` reserva continuidade antes de I/O e serializa todo o processamento pós-ACK em FIFO, impedindo que uma rodada ultrapasse outra durante MySQL/callback do executor;",
    "handoff BUG014C"
)
replace_once(
    handoff,
    """- `/receber-sinal` ainda responde antes de concluir o processamento e não possui serialização explícita do pós-ACK; tratar esse risco em patch separado do protocolo do executor;\n""",
    """,
    "remove handoff serial risk"
)
replace_once(
    handoff,
    """- quando tocar criação/envio de ordens, o executor fake deve comprovar `PREPARANDO`, enviar callback autenticado `EXECUTADA` e validar que o Node só então promove a auditoria; preferir callback antes do ACK no teste para cobrir a corrida mais difícil;\n""",
    """- quando tocar criação/envio de ordens, o executor fake deve comprovar `PREPARANDO`, enviar callback autenticado `EXECUTADA` e validar que o Node só então promove a auditoria; o E2E também deve manter o cenário em que a rodada 2 chega enquanto a rodada 1 ainda espera o executor, comprovando o FIFO pós-ACK;\n""",
    "handoff validation FIFO"
)

replace_once(
    changelog,
    "- `executar_aposta_na_tela` retorna estado estruturado: falha antes de qualquer clique de alvo é definitiva, falha após clique parcial é ambígua, e sucesso significa somente conclusão local dos cliques — não confirmação transacional do site externo.\n",
    "- `executar_aposta_na_tela` retorna estado estruturado: falha antes de qualquer clique de alvo é definitiva, falha após clique parcial é ambígua, e sucesso significa somente conclusão local dos cliques — não confirmação transacional do site externo.\n- BUG-014C: resultados de rodada passam a reservar continuidade sincronamente antes do primeiro I/O e todo o trabalho pós-ACK de `/receber-sinal` é serializado em FIFO; a rodada seguinte pode receber ACK imediatamente, mas só altera sessão/histórico/sinais/auditoria depois da anterior liberar o turno.\n",
    "CHANGELOG BUG014C"
)

print("BUG-014C patch aplicado com sucesso")
