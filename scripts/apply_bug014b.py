from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_span(path, start, end, new_segment, label):
    text = path.read_text(encoding="utf-8")
    i = text.find(start)
    if i < 0:
        raise RuntimeError(f"{label}: marcador inicial ausente")
    j = text.find(end, i)
    if j < 0:
        raise RuntimeError(f"{label}: marcador final ausente")
    path.write_text(text[:i] + new_segment + text[j:], encoding="utf-8")


node = ROOT / "robo-bacbo" / "bot2_coletor.js"
python = ROOT / "robo-sync-pilot" / "robo.py"
node_test = ROOT / "robo-bacbo" / "test" / "order-intent.test.js"
py_test = ROOT / "robo-sync-pilot" / "tests" / "test_pure_logic.py"
playwright_test = ROOT / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"
restart_test = ROOT / "robo-sync-pilot" / "integration" / "executor-idempotency-restart.py"
e2e = ROOT / "robo-bacbo" / "integration" / "controlled-e2e-smoke.js"
env_example = ROOT / ".env.example"
current_state = ROOT / "docs" / "CURRENT_STATE.md"
known_issues = ROOT / "docs" / "KNOWN_ISSUES.md"
handoff = ROOT / "docs" / "GEMINI_HANDOFF.md"
changelog = ROOT / "CHANGELOG.md"

# ================================================================
# Node: endpoint interno de callback + espera pelo resultado DOM
# ================================================================
replace_once(
    node,
    """app.use((req, res, next) => {\n    if (req.path === '/receber-sinal') return next();\n    if (!ADMIN_AUTH_REQUIRED || sessaoAdminValidaCookie(req.get('Cookie'))) return next();\n""",
    """app.use((req, res, next) => {\n    const rotaInterna = req.path === '/receber-sinal' || req.path === '/executor-status';\n    if (rotaInterna) return next();\n    if (!ADMIN_AUTH_REQUIRED || sessaoAdminValidaCookie(req.get('Cookie'))) return next();\n""",
    "middleware admin interno"
)
replace_once(
    node,
    """app.use((req, res, next) => {\n    const rotaDependeDeInicializacao = req.path === '/receber-sinal' || req.path.startsWith('/api/');\n""",
    """app.use((req, res, next) => {\n    const rotaDependeDeInicializacao = req.path === '/receber-sinal'\n        || req.path === '/executor-status'\n        || req.path.startsWith('/api/');\n""",
    "middleware init interno"
)
replace_once(
    node,
    """const EXECUTOR_TIMEOUT_MS = 5000;\nconst EXECUTOR_MAX_ATTEMPTS = 2;\nconst TELEGRAM_TIMEOUT_MS = 3000;\n""",
    """const EXECUTOR_TIMEOUT_MS = 5000;\nconst EXECUTOR_MAX_ATTEMPTS = 2;\nconst executorExecutionTimeoutConfig = Number(process.env.EXECUTOR_EXECUTION_TIMEOUT_MS || 20000);\nconst EXECUTOR_EXECUTION_TIMEOUT_MS = (\n    Number.isFinite(executorExecutionTimeoutConfig)\n    && executorExecutionTimeoutConfig >= 3000\n    && executorExecutionTimeoutConfig <= 120000\n        ? executorExecutionTimeoutConfig\n        : 20000\n);\nconst CONFIRMACOES_EXECUTOR_PENDENTES = new Map();\nconst STATUS_EXECUTOR_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);\nconst TELEGRAM_TIMEOUT_MS = 3000;\n""",
    "config callback executor"
)

node_transport = r'''function criarEsperaResultadoExecutor(orderId) {
    const id = String(orderId || '').trim().toLowerCase();
    if (!id) throw new Error('order_id ausente ao criar espera de execução');
    if (CONFIRMACOES_EXECUTOR_PENDENTES.has(id)) {
        throw new Error(`Já existe espera de execução ativa para ${id}`);
    }

    let finalizado = false;
    let resultadoAtual = null;
    let resolverPromessa = null;
    let timeoutId = null;
    const promessa = new Promise(resolve => { resolverPromessa = resolve; });

    const finalizar = (resultado) => {
        if (finalizado) return false;
        finalizado = true;
        resultadoAtual = resultado;
        if (timeoutId) clearTimeout(timeoutId);
        CONFIRMACOES_EXECUTOR_PENDENTES.delete(id);
        resolverPromessa(resultado);
        return true;
    };

    timeoutId = setTimeout(() => {
        finalizar({
            order_id: id,
            status: 'TIMEOUT',
            motivo: `Sem callback do executor em ${EXECUTOR_EXECUTION_TIMEOUT_MS}ms`
        });
    }, EXECUTOR_EXECUTION_TIMEOUT_MS);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();

    CONFIRMACOES_EXECUTOR_PENDENTES.set(id, {
        criado_em: Date.now(),
        finalizar
    });

    return {
        promessa,
        resultadoAtual: () => resultadoAtual,
        cancelar: () => finalizar({ order_id: id, status: 'CANCELADA', motivo: 'Espera cancelada' })
    };
}

function registrarResultadoExecucaoExecutor(dados) {
    const id = String(dados && dados.order_id || '').trim().toLowerCase();
    const pendente = CONFIRMACOES_EXECUTOR_PENDENTES.get(id);
    if (!pendente) return false;
    return pendente.finalizar({
        order_id: id,
        status: String(dados.status || '').trim().toUpperCase(),
        motivo: String(dados.motivo || '').slice(0, 300)
    });
}

function erroResultadoExecucaoExecutor(resultado) {
    const status = String(resultado && resultado.status || 'TIMEOUT').toUpperCase();
    const motivo = String(resultado && resultado.motivo || status);
    const erro = new Error(`Executor reportou ${status}: ${motivo}`);
    erro.status_executor = status;
    erro.envio_ambiguo = status === 'AMBIGUA' || status === 'TIMEOUT';
    return erro;
}

async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID()) {
    const esperaExecucao = criarEsperaResultadoExecutor(orderId);
    let ultimoErro = null;
    let confirmacaoAceite = null;

    try {
        for (let tentativa = 1; tentativa <= EXECUTOR_MAX_ATTEMPTS; tentativa++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);

            try {
                const resposta = await fetch(EXECUTOR_URL, {
                    method: 'POST',
                    headers: headersInternos(),
                    body: JSON.stringify({ order_id: orderId, alvo, valor }),
                    signal: controller.signal
                });

                let corpo = null;
                try { corpo = await resposta.json(); } catch(e) {}

                if (!resposta.ok) {
                    const detalhe = corpo && (corpo.erro || corpo.status)
                        ? (corpo.erro || corpo.status)
                        : `HTTP ${resposta.status}`;
                    const erroHttp = new Error(`Executor recusou a ordem: ${detalhe}`);
                    erroHttp.statusHttp = resposta.status;
                    erroHttp.envio_ambiguo = !(corpo && corpo.aceita === false) && resposta.status >= 500;
                    throw erroHttp;
                }

                if (
                    !corpo
                    || !corpo.dados
                    || corpo.dados.order_id !== orderId
                    || corpo.dados.alvo !== alvo
                    || Number(corpo.dados.valor) !== Number(valor)
                ) {
                    throw new Error("Executor respondeu sem confirmar o ID e os dados da ordem");
                }

                if (corpo.duplicada === true) {
                    console.warn(`♻️ Executor confirmou ordem idempotente já recebida: ${orderId}`);
                }

                confirmacaoAceite = corpo;
                break;
            } catch (e) {
                const timeout = e && e.name === 'AbortError';
                const statusHttp = Number(e && e.statusHttp);
                const classificacaoExplicita = e && typeof e.envio_ambiguo === 'boolean';
                const erroRepetivel = classificacaoExplicita
                    ? e.envio_ambiguo
                    : (timeout || !Number.isFinite(statusHttp) || statusHttp >= 500);

                ultimoErro = timeout
                    ? new Error(`Timeout de ${EXECUTOR_TIMEOUT_MS}ms aguardando aceite da ordem ${orderId}`)
                    : e;
                ultimoErro.envio_ambiguo = erroRepetivel;

                // Um callback pode chegar mesmo quando a resposta HTTP do aceite se perdeu.
                if (esperaExecucao.resultadoAtual()) break;

                if (erroRepetivel && tentativa < EXECUTOR_MAX_ATTEMPTS) {
                    console.warn(`⚠️ Falha ambígua no aceite ${orderId}; repetindo com o mesmo ID (${tentativa + 1}/${EXECUTOR_MAX_ATTEMPTS}).`);
                    continue;
                }
                break;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        const resultadoAntecipado = esperaExecucao.resultadoAtual();
        if (
            !confirmacaoAceite
            && ultimoErro
            && ultimoErro.envio_ambiguo !== true
            && !resultadoAntecipado
        ) {
            throw ultimoErro;
        }

        const resultadoExecucao = resultadoAntecipado || await esperaExecucao.promessa;
        if (resultadoExecucao.status !== 'EXECUTADA') {
            throw erroResultadoExecucaoExecutor(resultadoExecucao);
        }

        if (!confirmacaoAceite && ultimoErro) {
            console.warn(
                `⚠️ ACK HTTP da ordem ${orderId} ficou ambíguo, mas callback EXECUTADA foi recebido; `
                + `o resultado local da interação DOM prevaleceu.`
            );
        }

        return {
            ...(confirmacaoAceite || {}),
            status: confirmacaoAceite?.status || 'Execução DOM confirmada por callback',
            duplicada: confirmacaoAceite?.duplicada === true,
            dados: confirmacaoAceite?.dados || { order_id: orderId, alvo, valor },
            execucao: resultadoExecucao
        };
    } finally {
        esperaExecucao.cancelar();
    }
}

function classificarStatusFalhaEnvioExecutor(erro) {
    const statusExecutor = String(erro && erro.status_executor || '').toUpperCase();
    if (statusExecutor === 'FALHOU') return 'FALHA_EXECUCAO';
    if (statusExecutor === 'EXPIRADA') return 'ORDEM_EXPIRADA';
    return erro && erro.envio_ambiguo === true ? 'ENVIO_AMBIGUO' : 'FALHA_ENVIO';
}

'''
replace_span(
    node,
    "async function enviarOrdemAoExecutor",
    "async function criarIntencaoOrdem",
    node_transport,
    "transporte+callback Node"
)

callback_route = r'''app.post("/executor-status", (req, res) => {
    if (!requisicaoInternaAutorizada(req)) {
        return res.status(401).json({ erro: "Nao autorizado" });
    }

    const dados = req.body || {};
    const orderId = String(dados.order_id || '').trim().toLowerCase();
    const status = String(dados.status || '').trim().toUpperCase();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orderId)) {
        return res.status(400).json({ erro: 'order_id invalido' });
    }
    if (!STATUS_EXECUTOR_VALIDOS.has(status)) {
        return res.status(400).json({ erro: 'status_executor_invalido' });
    }

    const entregue = registrarResultadoExecucaoExecutor({
        order_id: orderId,
        status,
        motivo: dados.motivo
    });

    if (!entregue) {
        console.warn(`⚠️ Callback órfão do executor para ${orderId} (${status}); auditoria não foi promovida automaticamente.`);
    }

    return res.json({ recebido: true, orfa: !entregue });
});

'''
replace_once(
    node,
    'app.post("/receber-sinal", async (req, res) => {\n',
    callback_route + 'app.post("/receber-sinal", async (req, res) => {\n',
    "rota callback Node"
)

# ================================================================
# Python: readiness + TTL + callback do resultado local do DOM
# ================================================================
replace_once(
    python,
    """WEBHOOK_JS = os.getenv("NODE_WEBHOOK_URL", "http://127.0.0.1:3000/receber-sinal")\nINTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()\n""",
    """WEBHOOK_JS = os.getenv("NODE_WEBHOOK_URL", "http://127.0.0.1:3000/receber-sinal")\nEXECUTOR_STATUS_URL = (\n    os.getenv("NODE_EXECUTOR_STATUS_URL", "http://127.0.0.1:3000/executor-status").strip()\n    or "http://127.0.0.1:3000/executor-status"\n)\nINTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()\n""",
    "URL callback Python"
)
replace_once(
    python,
    """EXECUTOR_ORDER_JOURNAL_FILE = (\n    os.getenv("EXECUTOR_ORDER_JOURNAL_FILE", EXECUTOR_ORDER_JOURNAL_DEFAULT).strip()\n    or EXECUTOR_ORDER_JOURNAL_DEFAULT\n)\n\ntry:\n    BALANCE_SYNC_INTERVAL_SECONDS""",
    """EXECUTOR_ORDER_JOURNAL_FILE = (\n    os.getenv("EXECUTOR_ORDER_JOURNAL_FILE", EXECUTOR_ORDER_JOURNAL_DEFAULT).strip()\n    or EXECUTOR_ORDER_JOURNAL_DEFAULT\n)\n\ntry:\n    EXECUTOR_ORDER_TTL_SECONDS = max(1.0, min(60.0, float(os.getenv("EXECUTOR_ORDER_TTL_SECONDS", "8"))))\nexcept ValueError:\n    EXECUTOR_ORDER_TTL_SECONDS = 8.0\n\ntry:\n    BALANCE_SYNC_INTERVAL_SECONDS""",
    "TTL Python"
)
replace_once(
    python,
    """ordens_executor_recebidas = {}\nordens_executor_lock = threading.Lock()\nORDEM_ID_LIMITE_MEMORIA = 5000\n""",
    """ordens_executor_recebidas = {}\nordens_executor_lock = threading.Lock()\nexecutor_pronto = threading.Event()\nORDEM_ID_LIMITE_MEMORIA = 5000\n""",
    "readiness event"
)

registrar_novo = r'''def registrar_ordem_idempotente(dados, aceitar_nova=True):
    order_id = dados["order_id"]
    alvo = dados["alvo"]
    valor = float(dados["valor"])
    ordem_normalizada = {
        "order_id": order_id,
        "alvo": alvo,
        "valor": valor
    }

    with ordens_executor_lock:
        existente = ordens_executor_recebidas.get(order_id)
        if existente is not None:
            mesmo_payload = (
                existente["alvo"] == alvo
                and float(existente["valor"]) == valor
            )
            return ("duplicada" if mesmo_payload else "conflito"), existente

        if not aceitar_nova:
            return "indisponivel", ordem_normalizada

        ordem_normalizada["aceita_em_ms"] = int(time.time() * 1000)
        novo_estado = dict(ordens_executor_recebidas)
        novo_estado[order_id] = ordem_normalizada
        while len(novo_estado) > ORDEM_ID_LIMITE_MEMORIA:
            primeiro_id = next(iter(novo_estado))
            del novo_estado[primeiro_id]

        # Persiste antes do ACK/fila: se o disco falhar, a ordem nao e aceita.
        persistir_ordens_executor(novo_estado)
        ordens_executor_recebidas.clear()
        ordens_executor_recebidas.update(novo_estado)
        fila_apostas.put(ordem_normalizada)

    return "nova", ordem_normalizada

'''
replace_span(
    python,
    "def registrar_ordem_idempotente",
    "ordens_persistidas = carregar_ordens_executor_persistidas()",
    registrar_novo,
    "registrar idempotente Python"
)

route_python = r'''@app.route('/apostar', methods=['POST'])
def receber_aposta():
    """Recebe ordem autenticada; nova exposição só entra na fila quando o Playwright está pronto."""
    if not requisicao_interna_autorizada():
        return jsonify({"erro": "Nao autorizado"}), 401

    dados = request.get_json(silent=True)
    if not isinstance(dados, dict):
        return jsonify({"erro": "Payload JSON invalido"}), 400

    order_id = str(dados.get("order_id") or "").strip().lower()
    alvo = dados.get("alvo")
    valor = dados.get("valor")

    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", order_id):
        return jsonify({"erro": "order_id invalido"}), 400
    if alvo not in {"PlayerWon", "BankerWon", "Tie"}:
        return jsonify({"erro": "Alvo invalido"}), 400
    if not isinstance(valor, (int, float)) or isinstance(valor, bool) or valor <= 0:
        return jsonify({"erro": "Valor de aposta invalido"}), 400

    try:
        resultado_idempotencia, ordem = registrar_ordem_idempotente({
            "order_id": order_id,
            "alvo": alvo,
            "valor": valor
        }, aceitar_nova=executor_pronto.is_set())
    except Exception as e:
        print(f"❌ Falha ao persistir idempotencia da ordem {order_id}: {type(e).__name__}: {e}")
        return jsonify({"erro": "Falha ao persistir idempotencia da ordem", "aceita": False}), 503

    if resultado_idempotencia == "conflito":
        return jsonify({
            "erro": "order_id reutilizado com payload diferente",
            "aceita": False,
            "dados": ordem
        }), 409

    # Duplicata já persistida continua idempotente mesmo se o Playwright caiu depois do aceite original.
    if resultado_idempotencia == "duplicada":
        print(f"\n♻️ ORDEM JA RECEBIDA: {order_id} - fila preservada sem duplicar aposta")
        return jsonify({
            "status": "Ordem ja recebida; fila preservada",
            "aceita": True,
            "duplicada": True,
            "dados": ordem
        }), 200

    if resultado_idempotencia == "indisponivel":
        print(f"⚠️ ORDEM RECUSADA SEM ACEITE: {order_id} - Playwright ainda não está pronto")
        return jsonify({
            "erro": "Executor Playwright nao esta pronto",
            "aceita": False,
            "duplicada": False,
            "dados": ordem
        }), 503

    print(f"\n📥 ORDEM AUTENTICADA DO NODE.JS: {order_id} - Apostar R$ {valor} no alvo {alvo}")
    return jsonify({
        "status": "Aposta aceita na fila; aguardando resultado da interacao DOM",
        "aceita": True,
        "duplicada": False,
        "dados": ordem
    }), 200

'''
replace_span(
    python,
    "@app.route('/apostar', methods=['POST'])",
    "def iniciar_servidor_flask():",
    route_python,
    "rota apostar Python"
)

helpers_python = r'''def ordem_executor_expirada(ordem, agora_ms=None):
    aceita_em_ms = float(ordem.get("aceita_em_ms") or 0)
    if aceita_em_ms <= 0:
        return True
    referencia = float(agora_ms) if agora_ms is not None else time.time() * 1000
    return (referencia - aceita_em_ms) > (EXECUTOR_ORDER_TTL_SECONDS * 1000)


def reportar_status_execucao_node(ordem, resultado):
    order_id = str(ordem.get("order_id") or "").strip().lower()
    status = str((resultado or {}).get("status") or "AMBIGUA").strip().upper()
    if status not in {"EXECUTADA", "FALHOU", "EXPIRADA", "AMBIGUA"}:
        status = "AMBIGUA"
    motivo = str((resultado or {}).get("motivo") or "").strip()[:300]
    payload = {"order_id": order_id, "status": status, "motivo": motivo}

    ultimo_erro = None
    for _ in range(2):
        try:
            resposta = requests.post(
                EXECUTOR_STATUS_URL,
                json=payload,
                headers={"X-Internal-Token": INTERNAL_API_TOKEN},
                timeout=2
            )
            resposta.raise_for_status()
            return True
        except Exception as e:
            ultimo_erro = e

    registrar_erro_limitado(
        "executor_status_node",
        f"⚠️ Falha ao reportar status {status} da ordem {order_id} ao Node: {type(ultimo_erro).__name__}: {ultimo_erro}",
        30
    )
    return False


def processar_ordem_executor(page, ordem):
    if ordem_executor_expirada(ordem):
        resultado = {
            "status": "EXPIRADA",
            "motivo": f"Ordem excedeu TTL de {EXECUTOR_ORDER_TTL_SECONDS:g}s antes da interação DOM",
            "cliques_alvo": 0
        }
    elif not executor_pronto.is_set():
        resultado = {
            "status": "FALHOU",
            "motivo": "Executor ficou indisponivel antes da interação DOM",
            "cliques_alvo": 0
        }
    else:
        resultado = executar_aposta_na_tela(page, ordem)
        if not isinstance(resultado, dict) or resultado.get("status") not in {"EXECUTADA", "FALHOU", "AMBIGUA"}:
            resultado = {
                "status": "AMBIGUA",
                "motivo": "Resultado local da tentativa DOM ficou indeterminado",
                "cliques_alvo": 0
            }

    reportar_status_execucao_node(ordem, resultado)
    return resultado


'''
replace_once(
    python,
    """threading.Thread(target=iniciar_servidor_flask, daemon=True).start()\n\nultimo_tempo_rodada = 0\n""",
    """threading.Thread(target=iniciar_servidor_flask, daemon=True).start()\n\n""" + helpers_python + "ultimo_tempo_rodada = 0\n",
    "helpers lifecycle Python"
)

execucao_python = r'''def executar_aposta_na_tela(page, aposta):
    """Executa a tentativa DOM e retorna um estado local explícito; não prova aceite transacional externo."""
    cliques_alvo = 0
    try:
        alvo_bruto = aposta.get("alvo")
        valor_bruto = float(aposta.get("valor", 0))
        valor_total = int(valor_bruto)

        if valor_bruto <= 0 or valor_bruto != valor_total:
            return {"status": "FALHOU", "motivo": "Valor incompatível com fichas inteiras", "cliques_alvo": 0}

        mapa_alvos = {
            "PlayerWon": "bacbo-bet-spot-Player",
            "BankerWon": "bacbo-bet-spot-Banker",
            "Tie": "bacbo-bet-spot-Tie"
        }
        seletor_alvo = mapa_alvos.get(alvo_bruto)
        if not seletor_alvo:
            print(f"❌ Erro: Alvo '{alvo_bruto}' não mapeado.")
            return {"status": "FALHOU", "motivo": "Alvo não mapeado", "cliques_alvo": 0}

        frame_jogo = None
        for frame in page.frames:
            if "evolution" in frame.url.lower() or "evocdn" in frame.url.lower() or "game" in frame.url.lower():
                if frame.locator("div[data-role='chip']").count() > 0:
                    frame_jogo = frame
                    break

        if not frame_jogo:
            print("❌ Erro: Iframe da mesa não encontrado! A tela pode estar carregando.")
            return {"status": "FALHOU", "motivo": "Iframe da mesa não encontrado", "cliques_alvo": 0}

        fichas_disponiveis = [5000, 2500, 500, 125, 25, 10, 5]
        valor_restante = valor_total
        cliques_necessarios = []

        for ficha in fichas_disponiveis:
            qtd = valor_restante // ficha
            if qtd > 0:
                cliques_necessarios.append((ficha, qtd))
                valor_restante %= ficha

        if valor_restante > 0 or not cliques_necessarios:
            print(f"⚠️ Aposta ignorada: R$ {valor_total} não pode ser representado exatamente pelas fichas disponíveis.")
            return {"status": "FALHOU", "motivo": "Valor não representável pelas fichas", "cliques_alvo": 0}

        for ficha, qtd in cliques_necessarios:
            seletor_ficha = f"div[data-role='chip'][data-value='{ficha}']"
            try:
                ficha_elemento = frame_jogo.locator(seletor_ficha).first
                ficha_elemento.wait_for(state="visible", timeout=3000)
                ficha_elemento.click(force=True, timeout=3000)
                page.wait_for_timeout(200)

                alvo_elemento = frame_jogo.locator(f"[data-role='{seletor_alvo}']").first
                alvo_elemento.wait_for(state="visible", timeout=3000)
                for _ in range(qtd):
                    alvo_elemento.click(force=True, timeout=3000)
                    cliques_alvo += 1
                    page.wait_for_timeout(150)
            except PlaywrightTimeoutError as e:
                status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                print(f"⚠️ Timeout durante tentativa DOM da ficha {ficha}: {e}")
                return {
                    "status": status,
                    "motivo": f"Timeout DOM após {cliques_alvo} clique(s) de alvo",
                    "cliques_alvo": cliques_alvo
                }
            except Exception as e:
                status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                print(f"⚠️ Falha durante tentativa DOM da ficha {ficha}: {e}")
                return {
                    "status": status,
                    "motivo": f"Falha DOM após {cliques_alvo} clique(s) de alvo",
                    "cliques_alvo": cliques_alvo
                }

        print(
            f"🎯 INTERAÇÃO DOM CONCLUÍDA: R$ {valor_total} no {alvo_bruto}; "
            f"{cliques_alvo} clique(s) de alvo executado(s)."
        )
        return {
            "status": "EXECUTADA",
            "motivo": "Interação DOM concluída sem erro local",
            "cliques_alvo": cliques_alvo
        }
    except Exception as e:
        status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
        print(f"❌ Erro grave na engine de aposta: {e}")
        return {
            "status": status,
            "motivo": f"Erro inesperado após {cliques_alvo} clique(s) de alvo",
            "cliques_alvo": cliques_alvo
        }

'''
replace_span(
    python,
    "def executar_aposta_na_tela",
    "def parsear_valor_monetario",
    execucao_python,
    "resultado estruturado Playwright"
)

replace_once(
    python,
    """def iniciar_robo_blindado():\n    with sync_playwright() as p:\n""",
    """def iniciar_robo_blindado():\n    executor_pronto.clear()\n    with sync_playwright() as p:\n""",
    "clear readiness startup"
)
replace_once(
    python,
    """                ws.on("framereceived", capturar_frame)\n                ws.on("close", lambda ws: status_conexao.update({"ativa": False, "ws_conectado": False}))\n""",
    """                ws.on("framereceived", capturar_frame)\n\n                def websocket_fechado(_ws):\n                    executor_pronto.clear()\n                    status_conexao.update({"ativa": False, "ws_conectado": False})\n\n                ws.on("close", websocket_fechado)\n""",
    "readiness websocket close"
)
replace_once(
    python,
    """        while True:\n            try:\n                status_conexao["ws_conectado"] = False\n""",
    """        while True:\n            try:\n                executor_pronto.clear()\n                status_conexao["ws_conectado"] = False\n""",
    "clear readiness reconnect"
)
replace_once(
    python,
    """                print("✅ Acesso validado! Tudo pronto.")\n                \n                tempo_passado = 0\n""",
    """                executor_pronto.set()\n                print("✅ Acesso validado! Executor liberado para novas ordens.")\n                \n                tempo_passado = 0\n""",
    "set readiness"
)
replace_once(
    python,
    """                        if not fila_apostas.empty():\n                            ordem = fila_apostas.get()\n                            executar_aposta_na_tela(page, ordem)\n""",
    """                        if not fila_apostas.empty():\n                            ordem = fila_apostas.get()\n                            processar_ordem_executor(page, ordem)\n""",
    "consume lifecycle"
)
replace_once(
    python,
    """                    tempo_passado += 10000\n                \n            except PlaywrightTimeoutError as e:\n                registrar_erro_limitado(\n""",
    """                    tempo_passado += 10000\n\n                executor_pronto.clear()\n                \n            except PlaywrightTimeoutError as e:\n                executor_pronto.clear()\n                registrar_erro_limitado(\n""",
    "clear readiness timeout"
)
replace_once(
    python,
    """            except Exception as e:\n                registrar_erro_limitado(\n                    "loop_principal",\n""",
    """            except Exception as e:\n                executor_pronto.clear()\n                registrar_erro_limitado(\n                    "loop_principal",\n""",
    "clear readiness generic"
)
replace_once(
    python,
    """        except KeyboardInterrupt:\n            print("\\n👋 Robô desligado com sucesso.")\n""",
    """        except KeyboardInterrupt:\n            executor_pronto.clear()\n            print("\\n👋 Robô desligado com sucesso.")\n""",
    "clear readiness keyboard"
)
replace_once(
    python,
    """        except Exception as e:\n            print(f"🔥 Executor reiniciando após falha não tratada: {type(e).__name__}: {e}")\n""",
    """        except Exception as e:\n            executor_pronto.clear()\n            print(f"🔥 Executor reiniciando após falha não tratada: {type(e).__name__}: {e}")\n""",
    "clear readiness restart"
)

# ================================================================
# Testes Node do lifecycle/callback
# ================================================================
node_test.write_text(r'''"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

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

test("5xx sem aceita=false continua ambiguo e usa mesmo order_id", async () => {
    let chamadas = 0;
    const corpos = [];
    const logic = carregarTransporte(async (_url, options) => {
        chamadas++;
        corpos.push(JSON.parse(options.body));
        return { ok: false, status: 503, json: async () => ({ erro: "indisponivel" }) };
    }, 45);

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, "22222222-2222-4222-8222-222222222222"),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "TIMEOUT"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
});

test("callback EXECUTADA pode chegar antes do ACK HTTP", async () => {
    let registrar = null;
    const orderId = "33333333-3333-4333-8333-333333333333";
    const logic = carregarTransporte(async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.order_id, orderId);
        assert.equal(registrar({ order_id: orderId, status: "EXECUTADA", motivo: "DOM ok" }), true);
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
    assert.match(source, /FALHA_EXECUCAO/);
    assert.match(source, /ORDEM_EXPIRADA/);
});
''', encoding="utf-8")

# ================================================================
# Testes Python puros: timestamp/TTL da fila
# ================================================================
replace_once(py_test, "import threading\nimport unittest\n", "import threading\nimport time\nimport unittest\n", "import time teste Python")
replace_once(
    py_test,
    '        "registrar_ordem_idempotente",\n    ]\n',
    '        "registrar_ordem_idempotente",\n        "ordem_executor_expirada",\n    ]\n',
    "extrair TTL"
)
replace_once(
    py_test,
    '            "threading": threading,\n            "ordens_executor_recebidas": {},\n',
    '            "threading": threading,\n            "time": time,\n            "ordens_executor_recebidas": {},\n',
    "namespace time"
)
replace_once(
    py_test,
    '            "ORDEM_ID_LIMITE_MEMORIA": 5000,\n            "EXECUTOR_ORDER_JOURNAL_FILE": self.journal,\n',
    '            "ORDEM_ID_LIMITE_MEMORIA": 5000,\n            "EXECUTOR_ORDER_TTL_SECONDS": 8.0,\n            "EXECUTOR_ORDER_JOURNAL_FILE": self.journal,\n',
    "namespace TTL"
)
replace_once(
    py_test,
    """        self.assertEqual(self.ns["fila_apostas"].qsize(), 1)\n        self.assertTrue(os.path.isfile(self.journal))\n""",
    """        self.assertEqual(self.ns["fila_apostas"].qsize(), 1)\n        enfileirada = self.ns["fila_apostas"].queue[0]\n        self.assertGreater(enfileirada["aceita_em_ms"], 0)\n        self.assertTrue(os.path.isfile(self.journal))\n""",
    "timestamp fila"
)
replace_once(
    py_test,
    """    def test_journal_corrompido_falha_fechado(self):\n        with open(self.journal, "w", encoding="utf-8") as arquivo:\n            arquivo.write("{corrompido")\n\n        ns_reiniciado = self.criar_namespace()\n        with self.assertRaisesRegex(RuntimeError, "(?i)journal"):\n            ns_reiniciado["carregar_ordens_executor_persistidas"]()\n\n\nclass TestProcessarResultado""",
    """    def test_journal_corrompido_falha_fechado(self):\n        with open(self.journal, "w", encoding="utf-8") as arquivo:\n            arquivo.write("{corrompido")\n\n        ns_reiniciado = self.criar_namespace()\n        with self.assertRaisesRegex(RuntimeError, "(?i)journal"):\n            ns_reiniciado["carregar_ordens_executor_persistidas"]()\n\n    def test_ttl_considera_ordem_velha_expirada_e_timestamp_ausente_inseguro(self):\n        expirada = self.ns["ordem_executor_expirada"]\n        ordem = {"aceita_em_ms": 1000}\n        self.assertFalse(expirada(ordem, agora_ms=9000))\n        self.assertTrue(expirada(ordem, agora_ms=9001))\n        self.assertTrue(expirada({}, agora_ms=1000))\n\n\nclass TestProcessarResultado""",
    "teste TTL puro"
)

# ================================================================
# Integração Flask restart: readiness sem quebrar duplicata persistida
# ================================================================
restart_test.write_text(r'''import ast
import hmac
import json
import os
import pathlib
import queue
import re
import tempfile
import threading
import time

from flask import Flask, jsonify, request


ROBO_PATH = pathlib.Path(__file__).resolve().parents[1] / "robo.py"
SOURCE = ROBO_PATH.read_text(encoding="utf-8-sig")
TREE = ast.parse(SOURCE, filename=str(ROBO_PATH))

FUNCOES = [
    "requisicao_interna_autorizada",
    "persistir_ordens_executor",
    "carregar_ordens_executor_persistidas",
    "registrar_ordem_idempotente",
    "receber_aposta",
]

TOKEN = "bug001r-test-token-123456"
ORDER_1 = "123e4567-e89b-42d3-a456-426614174000"
ORDER_2 = "223e4567-e89b-42d3-a456-426614174001"


def carregar_funcoes(namespace):
    encontrados = {
        node.name: node
        for node in TREE.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in FUNCOES
    }
    faltantes = set(FUNCOES) - set(encontrados)
    if faltantes:
        raise RuntimeError(f"Funcoes nao encontradas em robo.py: {sorted(faltantes)}")

    modulo = ast.Module(body=[encontrados[nome] for nome in FUNCOES], type_ignores=[])
    ast.fix_missing_locations(modulo)
    exec(compile(modulo, str(ROBO_PATH), "exec"), namespace)


def criar_runtime(journal_path, pronto=True):
    app = Flask(f"bug001r-{id(journal_path)}-{os.urandom(4).hex()}")
    executor_pronto = threading.Event()
    if pronto:
        executor_pronto.set()
    namespace = {
        "app": app,
        "request": request,
        "jsonify": jsonify,
        "hmac": hmac,
        "json": json,
        "os": os,
        "re": re,
        "threading": threading,
        "time": time,
        "queue": queue,
        "INTERNAL_API_TOKEN": TOKEN,
        "EXECUTOR_ORDER_JOURNAL_FILE": str(journal_path),
        "ORDEM_ID_LIMITE_MEMORIA": 5000,
        "ordens_executor_recebidas": {},
        "ordens_executor_lock": threading.Lock(),
        "executor_pronto": executor_pronto,
        "fila_apostas": queue.Queue(),
    }
    carregar_funcoes(namespace)
    carregadas = namespace["carregar_ordens_executor_persistidas"]()
    return app, namespace, carregadas


def postar(client, order_id, alvo="PlayerWon", valor=10):
    return client.post(
        "/apostar",
        headers={"X-Internal-Token": TOKEN},
        json={"order_id": order_id, "alvo": alvo, "valor": valor},
    )


def assert_status(response, esperado):
    if response.status_code != esperado:
        raise AssertionError(
            f"HTTP {response.status_code} != {esperado}: {response.get_data(as_text=True)}"
        )


def main():
    with tempfile.TemporaryDirectory() as temp_dir:
        journal = pathlib.Path(temp_dir) / "executor-order-ids.json"

        app1, ns1, carregadas1 = criar_runtime(journal, pronto=True)
        assert carregadas1 == 0
        with app1.test_client() as client1:
            primeira = postar(client1, ORDER_1)
            assert_status(primeira, 200)
            corpo = primeira.get_json()
            assert corpo["aceita"] is True
            assert corpo["duplicada"] is False
            assert corpo["dados"]["order_id"] == ORDER_1
            assert ns1["fila_apostas"].qsize() == 1

        assert journal.is_file()
        payload = json.loads(journal.read_text(encoding="utf-8"))
        assert payload["version"] == 1
        assert len(payload["orders"]) == 1
        assert payload["orders"][0]["order_id"] == ORDER_1

        # Restart indisponível: ID já aceito segue idempotente, mas ID novo é recusado sem persistir/fila.
        app2, ns2, carregadas2 = criar_runtime(journal, pronto=False)
        assert carregadas2 == 1
        assert ns2["fila_apostas"].qsize() == 0

        with app2.test_client() as client2:
            duplicada = postar(client2, ORDER_1)
            assert_status(duplicada, 200)
            corpo_dup = duplicada.get_json()
            assert corpo_dup["aceita"] is True
            assert corpo_dup["duplicada"] is True
            assert ns2["fila_apostas"].qsize() == 0

            indisponivel = postar(client2, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(indisponivel, 503)
            corpo_ind = indisponivel.get_json()
            assert corpo_ind["aceita"] is False
            assert ns2["fila_apostas"].qsize() == 0
            payload_sem_nova = json.loads(journal.read_text(encoding="utf-8"))
            assert len(payload_sem_nova["orders"]) == 1

            ns2["executor_pronto"].set()
            nova = postar(client2, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(nova, 200)
            assert nova.get_json()["aceita"] is True
            assert nova.get_json()["duplicada"] is False
            assert ns2["fila_apostas"].qsize() == 1

            conflito = postar(client2, ORDER_2, alvo="PlayerWon", valor=25)
            assert_status(conflito, 409)
            assert ns2["fila_apostas"].qsize() == 1

        app3, ns3, carregadas3 = criar_runtime(journal, pronto=True)
        assert carregadas3 == 2
        with app3.test_client() as client3:
            duplicada2 = postar(client3, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(duplicada2, 200)
            assert duplicada2.get_json()["duplicada"] is True
            assert ns3["fila_apostas"].qsize() == 0

        journal.write_text("{arquivo-corrompido", encoding="utf-8")
        try:
            criar_runtime(journal)
        except RuntimeError as exc:
            assert "journal" in str(exc).lower()
        else:
            raise AssertionError("Journal corrompido deveria falhar fechado")

    print("BUG-001R/014B executor readiness + restart integration: PASS")


if __name__ == "__main__":
    main()
''', encoding="utf-8")

# ================================================================
# Playwright DOM: estados EXECUTADA/FALHOU/AMBIGUA
# ================================================================
replace_once(
    playwright_test,
    """}\n\n\nclass Handler""",
    r'''}

HTML["/game-partial.html"] = """<!doctype html>
<html><body><iframe src="/game-partial-frame.html"></iframe></body></html>"""
HTML["/game-partial-frame.html"] = """<!doctype html>
<html><body>
<script>window.__targetClicks = 0;</script>
<div data-role="chip" data-value="10">10</div>
<button data-role="bacbo-bet-spot-Player"
  onclick="window.__targetClicks++; this.remove()">Player descartável</button>
</body></html>"""


class Handler''',
    "HTML parcial"
)
replace_once(
    playwright_test,
    '            if "game-frame.html" in frame.url:\n',
    '            if "game" in frame.url and "frame" in frame.url:\n',
    "helper frame genérico"
)
replace_once(
    playwright_test,
    '            executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 35})\n\n            chips = frame.evaluate("window.__chipClicks")\n',
    '            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 35})\n\n            self.assertEqual(resultado["status"], "EXECUTADA")\n            self.assertEqual(resultado["cliques_alvo"], 2)\n            chips = frame.evaluate("window.__chipClicks")\n',
    "assert EXECUTADA"
)
replace_once(
    playwright_test,
    '            executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 4})\n\n            chips = frame.evaluate("window.__chipClicks")\n',
    '            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 4})\n\n            self.assertEqual(resultado["status"], "FALHOU")\n            self.assertEqual(resultado["cliques_alvo"], 0)\n            chips = frame.evaluate("window.__chipClicks")\n',
    "assert FALHOU"
)
replace_once(
    playwright_test,
    """        finally:\n            pagina.close()\n\n\nif __name__ == "__main__":\n""",
    """        finally:\n            pagina.close()\n\n    def test_falha_apos_primeiro_clique_de_alvo_e_ambigua(self):\n        pagina = self.nova_pagina("/game-partial.html")\n        try:\n            frame = self.frame_jogo(pagina)\n            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 20})\n\n            self.assertEqual(resultado["status"], "AMBIGUA")\n            self.assertEqual(resultado["cliques_alvo"], 1)\n            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)\n        finally:\n            pagina.close()\n\n\nif __name__ == "__main__":\n""",
    "teste AMBIGUA"
)

# ================================================================
# E2E Node: callback EXECUTADA chega antes do ACK de fila
# ================================================================
replace_once(
    e2e,
    """                orders.push({\n                    payload,\n                    token: req.headers["x-internal-token"],\n                    intentStatusBeforeAck: intent.status_ordem,\n                    intentIdBeforeAck: Number(intent.id)\n                });\n                res.writeHead(200, { "Content-Type": "application/json" });\n""",
    """                const callbackResponse = await fetch(`${BASE_URL}/executor-status`, {\n                    method: "POST",\n                    headers: {\n                        "Content-Type": "application/json",\n                        "X-Internal-Token": TOKEN\n                    },\n                    body: JSON.stringify({\n                        order_id: payload.order_id,\n                        status: "EXECUTADA",\n                        motivo: "DOM controlado concluído"\n                    })\n                });\n                const callbackData = await callbackResponse.json();\n                assert.equal(callbackResponse.status, 200);\n                assert.equal(callbackData.recebido, true);\n                assert.equal(callbackData.orfa, false, "callback antecipado deve encontrar waiter do Node");\n\n                orders.push({\n                    payload,\n                    token: req.headers["x-internal-token"],\n                    intentStatusBeforeAck: intent.status_ordem,\n                    intentIdBeforeAck: Number(intent.id),\n                    callbackBeforeAck: true\n                });\n                res.writeHead(200, { "Content-Type": "application/json" });\n""",
    "callback antecipado E2E"
)
replace_once(
    e2e,
    '            LOG_FILE_ENABLED: "false"\n',
    '            LOG_FILE_ENABLED: "false",\n            EXECUTOR_EXECUTION_TIMEOUT_MS: "5000"\n',
    "timeout E2E"
)
replace_once(
    e2e,
    """        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");\n        assert.ok(order.intentIdBeforeAck > 0);\n""",
    """        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");\n        assert.ok(order.intentIdBeforeAck > 0);\n        assert.equal(order.callbackBeforeAck, true);\n""",
    "assert callback antecipado"
)

# ================================================================
# .env + documentação
# ================================================================
replace_once(
    env_example,
    """EXECUTOR_ORDER_JOURNAL_FILE=\n\n# Autenticacao administrativa""",
    """EXECUTOR_ORDER_JOURNAL_FILE=\n# Nova ordem só é aceita quando o Playwright está conectado/pronto; depois do aceite ela deve começar em até este TTL.\nEXECUTOR_ORDER_TTL_SECONDS=8\n# O Node aguarda este tempo total pelo callback EXECUTADA/FALHOU/EXPIRADA/AMBIGUA do executor.\nEXECUTOR_EXECUTION_TIMEOUT_MS=20000\n\n# Autenticacao administrativa""",
    "env lifecycle"
)
replace_once(
    env_example,
    """NODE_WEBHOOK_URL=http://127.0.0.1:3000/receber-sinal\nEXECUTOR_URL=http://127.0.0.1:5000/apostar\n""",
    """NODE_WEBHOOK_URL=http://127.0.0.1:3000/receber-sinal\nNODE_EXECUTOR_STATUS_URL=http://127.0.0.1:3000/executor-status\nEXECUTOR_URL=http://127.0.0.1:5000/apostar\n""",
    "env callback URL"
)

replace_once(
    current_state,
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014A, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014B, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "header CURRENT_STATE"
)
replace_once(
    current_state,
    """- rejeição definitiva do executor marca a intenção `FALHA_ENVIO`; timeout, erro de transporte, 5xx ou confirmação inválida após os retries marcam `ENVIO_AMBIGUO`; ACK seguido de falha de finalização MySQL preserva `PREPARANDO` para não apagar a evidência de uma ordem externamente aceita;\n- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;\n""",
    """- o Flask só aceita um `order_id` novo quando o Playwright está efetivamente conectado/pronto; duplicatas já persistidas continuam idempotentes mesmo durante indisponibilidade;\n- cada nova ordem aceita recebe timestamp local e TTL (`EXECUTOR_ORDER_TTL_SECONDS`, padrão 8 s); se envelhecer antes da interação DOM, não é clicada e o executor reporta `EXPIRADA`;\n- `/apostar` continua sendo o ACK de fila, mas o Node agora mantém um waiter por `order_id` e só considera `enviarOrdemAoExecutor()` concluído após callback autenticado em `/executor-status`; o callback pode chegar antes do ACK HTTP sem se perder;\n- `executar_aposta_na_tela()` retorna `EXECUTADA` somente quando todos os cliques DOM planejados terminam sem erro local, `FALHOU` quando nenhum clique de alvo ocorreu e `AMBIGUA` quando houve clique(s) de alvo antes de uma falha; isso confirma a tentativa local no DOM, não aceite transacional pela plataforma externa;\n- `FALHOU` marca `FALHA_EXECUCAO`, `EXPIRADA` marca `ORDEM_EXPIRADA`, callback `AMBIGUA`/timeout permanece `ENVIO_AMBIGUO`, e recusa explícita sem aceite permanece `FALHA_ENVIO`;\n- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;\n""",
    "lifecycle CURRENT_STATE"
)
replace_once(
    current_state,
    """- job Playwright separado instala Chromium e executa DOM controlado local, validando `parsear_valor_monetario`, leitura de saldo no documento/iframe e os seletores de ficha/alvo da função `executar_aposta_na_tela` sem acessar o site real;\n- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; o fake só responde ao POST depois de consultar o MySQL e comprovar que o mesmo `order_id` já existe como `PREPARANDO`, então o fluxo segue para `PENDENTE` e depois `WIN` + `historico_resultados=GREEN/DIRETO`;\n""",
    """- job Playwright separado instala Chromium e executa DOM controlado local, validando parsing/saldo, `EXECUTADA` no fluxo completo, `FALHOU` sem clique e `AMBIGUA` quando a falha ocorre após o primeiro clique de alvo;\n- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; o fake comprova `PREPARANDO`, envia callback `EXECUTADA` antes do próprio ACK de fila e só então responde ao POST, validando que o waiter do Node já existia e que a linha avança para `PENDENTE`/`WIN`;\n""",
    "tests CURRENT_STATE"
)
replace_once(
    current_state,
    """- a intenção financeira agora é durável antes do POST externo, mas o ACK atual de `/apostar` ainda significa aceite na fila do executor, não confirmação de clique efetivo no DOM; timeout/5xx ficam registrados como `ENVIO_AMBIGUO` e ACK sem finalização MySQL preserva `PREPARANDO`;\n- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright deixa o efeito externo ambíguo; IDs já persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;\n- o executor ainda pode aceitar uma ordem enquanto o Playwright não está pronto e a fila ainda não possui TTL; confirmação real de execução, readiness e expiração de ordem pertencem ao próximo patch do lifecycle, não ao BUG-014A;\n""",
    """- readiness, TTL e callback de resultado DOM já fecham a janela de ordem velha/não pronta e impedem promoção para `PENDENTE` sem `EXECUTADA`; ainda assim, `EXECUTADA` significa apenas que os cliques locais terminaram sem erro observável, não que a plataforma externa confirmou atomicamente a aposta;\n- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright pode continuar deixando o efeito externo ambíguo; IDs persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;\n""",
    "riscos CURRENT_STATE"
)

replace_span(
    known_issues,
    "### BUG-014 — Lifecycle da ordem entre intenção, aceite e execução",
    "### BUG-001R — Restart do executor e exactly-once do efeito externo",
    r'''### BUG-014 — Lifecycle da ordem entre intenção, aceite e execução

Status: **BUG-014A/014B mitigaram intenção, readiness, TTL e confirmação local da tentativa DOM; serialização das rodadas Node ainda pendente**.

O BUG-014A passou a persistir `PREPARANDO` antes de qualquer POST externo. O BUG-014B acrescenta um lifecycle explícito entre Node e executor: ordem nova só é aceita quando o Playwright está pronto; cada aceite recebe timestamp e TTL; e o Python devolve o resultado da tentativa por callback autenticado em `/executor-status`.

O Node cria o waiter do `order_id` antes do POST, portanto um callback antecipado não se perde. `enviarOrdemAoExecutor()` só resolve com `EXECUTADA`. Uma tentativa sem clique de alvo retorna `FALHOU` e vira `FALHA_EXECUCAO`; ordem que vence na fila retorna `EXPIRADA` e vira `ORDEM_EXPIRADA`; falha após algum clique de alvo retorna `AMBIGUA`; ausência de callback continua `ENVIO_AMBIGUO`. Recusa `503` com `aceita=false` significa que o executor não persistiu/enfileirou um ID novo e é tratada como `FALHA_ENVIO` definitiva.

`EXECUTADA` não é uma garantia de exactly-once ou de aceite financeiro pela plataforma: significa somente que a automação local conseguiu completar todos os cliques planejados sem erro observável. Se o processo morrer exatamente durante a interação, a ambiguidade externa continua possível sem uma API transacional/idempotente do destino.

Risco residual separado: `/receber-sinal` ainda responde antes de concluir todo o processamento da rodada e não possui serialização explícita do pós-ACK. Esse ponto deve ser tratado em BUG-014C sem misturar novamente o protocolo do executor.

''',
    "BUG-014 KNOWN_ISSUES"
)

replace_once(
    handoff,
    "- BUG-014A: toda ordem DIRETO/GALE recebe intenção durável `PREPARANDO` no MySQL antes do POST ao executor; falha definitiva vira `FALHA_ENVIO`, falha ambígua vira `ENVIO_AMBIGUO` e ACK sem finalização de banco preserva `PREPARANDO`;",
    "- BUG-014A: toda ordem DIRETO/GALE recebe intenção durável `PREPARANDO` no MySQL antes do POST ao executor;\n- BUG-014B: novas ordens só são aceitas com Playwright pronto, possuem TTL de fila e exigem callback autenticado `EXECUTADA/FALHOU/EXPIRADA/AMBIGUA`; Node só promove `PREPARANDO` após `EXECUTADA`, e callback antecipado é suportado;",
    "handoff state BUG014B"
)
replace_once(
    handoff,
    """- BUG-014A garante intenção MySQL antes do efeito externo, mas `/apostar` ainda confirma fila, não clique efetivo; o próximo passo prioritário é lifecycle explícito no executor com readiness, TTL e estados de execução, sem afirmar exactly-once absoluto;\n- deduplicação do `order_id` sobrevive a restart, mas um crash exatamente durante o clique Playwright mantém ambiguidade sobre o efeito externo; IDs já persistidos não são reenfileirados automaticamente para priorizar prevenção de duplicidade;\n""",
    """- BUG-014B confirma conclusão local da tentativa DOM antes de `PENDENTE`, mas não confundir `EXECUTADA` com confirmação financeira transacional da plataforma; crash durante o clique ainda pode ser externamente ambíguo;\n- deduplicação do `order_id` sobrevive a restart e IDs já persistidos não são reenfileirados automaticamente para priorizar prevenção de duplicidade;\n""",
    "handoff risks BUG014B"
)
replace_once(
    handoff,
    """- quando tocar criação/envio de ordens, o executor fake deve comprovar que a intenção `PREPARANDO` com o mesmo `order_id` já está visível no MySQL antes de devolver ACK;\n""",
    """- quando tocar criação/envio de ordens, o executor fake deve comprovar `PREPARANDO`, enviar callback autenticado `EXECUTADA` e validar que o Node só então promove a auditoria; preferir callback antes do ACK no teste para cobrir a corrida mais difícil;\n""",
    "handoff validation BUG014B"
)

replace_once(
    changelog,
    "- No GALE, o encerramento `LOSS` da exposição anterior e a criação da nova intenção são transacionais antes do efeito externo; no DIRETO, `entradas_feitas` continua sendo incrementado somente após ACK e promoção da intenção para `PENDENTE`.\n",
    "- No GALE, o encerramento `LOSS` da exposição anterior e a criação da nova intenção são transacionais antes do efeito externo; no DIRETO, `entradas_feitas` continua sendo incrementado somente após ACK e promoção da intenção para `PENDENTE`.\n- BUG-014B: executor passa a rejeitar IDs novos enquanto o Playwright não está pronto, atribuir TTL à fila e reportar por callback autenticado `EXECUTADA`, `FALHOU`, `EXPIRADA` ou `AMBIGUA`; o Node cria o waiter antes do POST e só considera a ordem executada após `EXECUTADA`.\n- `executar_aposta_na_tela` retorna estado estruturado: falha antes de qualquer clique de alvo é definitiva, falha após clique parcial é ambígua, e sucesso significa somente conclusão local dos cliques — não confirmação transacional do site externo.\n",
    "CHANGELOG BUG014B"
)

print("BUG-014B patch aplicado com sucesso")
