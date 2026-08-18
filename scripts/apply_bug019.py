from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, new, label):
    i = text.find(start)
    if i < 0:
        raise RuntimeError(f"{label}: início não encontrado")
    j = text.find(end, i)
    if j < 0:
        raise RuntimeError(f"{label}: fim não encontrado")
    return text[:i] + new + text[j:]


# ---------------------------------------------------------------------
# Node backend
# ---------------------------------------------------------------------
bot_path = ROOT / "robo-bacbo" / "bot2_coletor.js"
bot = bot_path.read_text(encoding="utf-8")

bot = replace_once(
    bot,
    'const crypto = require("crypto");\n',
    'const crypto = require("crypto");\nconst {\n    calcularFichaSegura: calcularFichaSeguraProtecao,\n    validarPoliticaProtecao,\n    calcularPlanoAposta,\n    calcularPnLEtapa\n} = require("./tie_protection");\n',
    "import tie_protection"
)

bot = replace_once(
    bot,
    "                valor_entrada DECIMAL(12,2),\n                executor_order_id VARCHAR(64) DEFAULT NULL,",
    "                valor_entrada DECIMAL(12,2),\n                valor_empate DECIMAL(12,2) DEFAULT 0,\n                executor_order_id VARCHAR(64) DEFAULT NULL,",
    "schema valor_empate"
)

bot = replace_once(
    bot,
    '        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_order_id VARCHAR(64) DEFAULT NULL");',
    '        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_order_id VARCHAR(64) DEFAULT NULL");\n        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN valor_empate DECIMAL(12,2) DEFAULT 0");',
    "migration valor_empate"
)

bot = replace_between(
    bot,
    "function calcularFichaSegura(valorDesejado) {",
    "function criarDetalhesPadraoVazios() {",
    "function calcularFichaSegura(valorDesejado) {\n    return calcularFichaSeguraProtecao(valorDesejado);\n}\n\n",
    "wrapper calcularFichaSegura"
)

bot = replace_between(
    bot,
    "async function criarIntencaoOrdem(queryable, dados) {",
    "async function marcarIntencaoAposFalhaEnvio",
    '''async function criarIntencaoOrdem(queryable, dados) {
    const orderId = String(dados.order_id || crypto.randomUUID());
    const [resultado] = await queryable.query(
        `INSERT INTO auditoria_ordens
            (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,
             valor_entrada, valor_empate, executor_order_id, status_ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')`,
        [
            dados.trader_id,
            dados.estrategia_nome,
            dados.fonte_sinal,
            dados.alvo,
            dados.nivel,
            dados.risco_total,
            dados.valor_entrada,
            Math.max(0, Number(dados.valor_empate) || 0),
            orderId
        ]
    );

    const auditoriaId = Number(resultado.insertId);
    if (!Number.isInteger(auditoriaId) || auditoriaId <= 0) {
        throw new Error('MySQL nao retornou ID valido para a intencao de ordem');
    }

    return { auditoria_id: auditoriaId, order_id: orderId };
}

''',
    "criarIntencaoOrdem"
)

bot = replace_once(
    bot,
    "async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID()) {",
    "async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID(), apostas = null) {",
    "assinatura executor composto"
)

bot = replace_once(
    bot,
    "                    body: JSON.stringify({ order_id: orderId, alvo, valor }),",
    "                    body: JSON.stringify(Array.isArray(apostas) && apostas.length > 0\n                        ? { order_id: orderId, apostas }\n                        : { order_id: orderId, alvo, valor }),",
    "payload executor composto"
)

# Validação fail-closed ao ativar Auto-Trader.
bot = replace_once(
    bot,
    "        const novoAtivo = ativo === true || ativo === 1;\n        const saldoFresco = obterSaldoGlobalFresco();",
    "        const novoAtivo = ativo === true || ativo === 1;\n        if (novoAtivo) {\n            const politicaEmpate = validarPoliticaProtecao(config || {});\n            if (!politicaEmpate.ok) {\n                return res.status(400).json({ sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo });\n            }\n        }\n        const saldoFresco = obterSaldoGlobalFresco();",
    "validação POST auto trader"
)

# O mesmo trecho ocorre no PUT, mas sem saldoFresco imediatamente depois.
bot = replace_once(
    bot,
    "        const configJson = JSON.stringify(config || {});\n        const novoAtivo = ativo === true || ativo === 1;\n\n        const [existentes] = await dbPool.query(",
    "        const configJson = JSON.stringify(config || {});\n        const novoAtivo = ativo === true || ativo === 1;\n        if (novoAtivo) {\n            const politicaEmpate = validarPoliticaProtecao(config || {});\n            if (!politicaEmpate.ok) {\n                return res.status(400).json({ sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo });\n            }\n        }\n\n        const [existentes] = await dbPool.query(",
    "validação PUT auto trader"
)

# Fechamento de WIN/TIE com P&L real das duas pernas e razão X:1.
bot = replace_once(
    bot,
    "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "select sucesso valor empate"
)

bot = replace_once(
    bot,
    "                                    let vEntrada = parseFloat(pendentes[0].valor_entrada);\n                                    let vLucro = isTie ? (vEntrada * parseInt(mult.replace('x', ''))) - vEntrada : vEntrada;",
    "                                    let vEntrada = parseFloat(pendentes[0].valor_entrada);\n                                    let vEmpate = Math.max(0, Number(pendentes[0].valor_empate) || 0);\n                                    let vLucro = calcularPnLEtapa({\n                                        resultado: vencedor,\n                                        alvoPrincipal: est.entrada,\n                                        valorPrincipal: vEntrada,\n                                        valorEmpate: vEmpate,\n                                        multiplicadorEmpate: mult\n                                    });",
    "pnl sucesso"
)

# Gale: fecha a etapa anterior pelo P&L da rodada, não pelo risco acumulado.
bot = replace_once(
    bot,
    "const [pendentes] = await dbPool.query(`SELECT id, risco_total FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "select gale"
)

bot = replace_once(
    bot,
    "                                        let riscoAntigo = parseFloat(pendentes[0].risco_total);\n                                        let multGale = st.galeAtual === 1 ? (cf.gale_1_mult || 2.0) : (cf.gale_2_mult || 4.0);\n                                        let valorGale = calcularFichaSegura((cf.stake_inicial || 10.00) * multGale);\n                                        let alvoPython = est.entrada === 'Player' ? 'PlayerWon' : (est.entrada === 'Banker' ? 'BankerWon' : 'Tie');",
    "                                        let riscoAntigo = parseFloat(pendentes[0].risco_total);\n                                        const pnlEtapaAnterior = calcularPnLEtapa({\n                                            resultado: vencedor,\n                                            alvoPrincipal: est.entrada,\n                                            valorPrincipal: Number(pendentes[0].valor_entrada) || 0,\n                                            valorEmpate: Number(pendentes[0].valor_empate) || 0,\n                                            multiplicadorEmpate: mult\n                                        });\n                                        const planoGale = calcularPlanoAposta(cf, est, st.galeAtual);\n                                        if (!planoGale.ok) {\n                                            console.error(`❌ GALE ${st.galeAtual} do trader ${trader.id} bloqueado: ${planoGale.motivo}`);\n                                            continue;\n                                        }\n                                        let valorGale = planoGale.valor_principal;\n                                        let valorEmpateGale = planoGale.valor_empate;\n                                        let alvoPython = planoGale.apostas[0].alvo;",
    "plano gale"
)

bot = replace_once(
    bot,
    "                                                [-riscoAntigo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]",
    "                                                [pnlEtapaAnterior, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]",
    "pnl etapa anterior gale"
)

bot = replace_once(
    bot,
    "                                                risco_total: riscoAntigo + valorGale,\n                                                valor_entrada: valorGale,",
    "                                                risco_total: riscoAntigo + planoGale.exposicao_etapa,\n                                                valor_entrada: valorGale,\n                                                valor_empate: valorEmpateGale,",
    "auditoria gale valor empate"
)

bot = replace_once(
    bot,
    "                                            await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale);",
    "                                            await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale, planoGale.apostas);",
    "envio gale composto"
)

# Direto: plano único principal + Tie quando o sinal exigir.
bot = replace_once(
    bot,
    "                                    let valorArredondado = calcularFichaSegura(cf.stake_inicial || 10.00);\n                                    let alvoPython = est.entrada === 'Player' ? 'PlayerWon' : (est.entrada === 'Banker' ? 'BankerWon' : 'Tie');",
    "                                    const planoDireto = calcularPlanoAposta(cf, est, 0);\n                                    if (!planoDireto.ok) {\n                                        console.error(`❌ Entrada do trader ${trader.id} bloqueada: ${planoDireto.motivo}`);\n                                        continue;\n                                    }\n                                    let valorArredondado = planoDireto.valor_principal;\n                                    let valorEmpateDireto = planoDireto.valor_empate;\n                                    let alvoPython = planoDireto.apostas[0].alvo;",
    "plano direto"
)

bot = replace_once(
    bot,
    "                                            risco_total: valorArredondado,\n                                            valor_entrada: valorArredondado,",
    "                                            risco_total: planoDireto.exposicao_etapa,\n                                            valor_entrada: valorArredondado,\n                                            valor_empate: valorEmpateDireto,",
    "auditoria direto valor empate"
)

bot = replace_once(
    bot,
    "                                        await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto);",
    "                                        await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto, planoDireto.apostas);",
    "envio direto composto"
)

# RED final: P&L somente da etapa pendente; Tie sem proteção = -10% da cor.
bot = replace_once(
    bot,
    "const [pendentes] = await dbPool.query(`SELECT id, risco_total FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);",
    "select red final"
)

bot = replace_once(
    bot,
    "                                        let prejuizo = -Math.abs(parseFloat(pendentes[0].risco_total));",
    "                                        let prejuizo = calcularPnLEtapa({\n                                            resultado: vencedor,\n                                            alvoPrincipal: est.entrada,\n                                            valorPrincipal: Number(pendentes[0].valor_entrada) || 0,\n                                            valorEmpate: Number(pendentes[0].valor_empate) || 0,\n                                            multiplicadorEmpate: mult\n                                        });",
    "pnl red final"
)

bot_path.write_text(bot, encoding="utf-8")


# ---------------------------------------------------------------------
# Python executor: payload composto e preflight de todas as pernas
# ---------------------------------------------------------------------
py_path = ROOT / "robo-sync-pilot" / "robo.py"
py = py_path.read_text(encoding="utf-8")

helper = r'''def normalizar_apostas_recebidas(dados):
    if not isinstance(dados, dict):
        raise ValueError("Payload da ordem invalido")

    bruto = dados.get("apostas")
    if bruto is None:
        bruto = [{"alvo": dados.get("alvo"), "valor": dados.get("valor")}]

    if not isinstance(bruto, list) or not 1 <= len(bruto) <= 2:
        raise ValueError("Plano de aposta deve conter uma ou duas pernas")

    normalizadas = []
    alvos = set()
    for perna in bruto:
        if not isinstance(perna, dict):
            raise ValueError("Perna de aposta invalida")
        alvo = perna.get("alvo")
        valor_bruto = perna.get("valor")
        if alvo not in {"PlayerWon", "BankerWon", "Tie"}:
            raise ValueError("Alvo invalido")
        if alvo in alvos:
            raise ValueError("Plano de aposta contem alvo duplicado")
        if not isinstance(valor_bruto, (int, float)) or isinstance(valor_bruto, bool):
            raise ValueError("Valor de aposta invalido")
        valor = float(valor_bruto)
        if valor <= 0 or not valor.is_integer() or int(valor) % 5 != 0:
            raise ValueError("Valor de aposta deve ser multiplo inteiro de R$5")
        alvos.add(alvo)
        normalizadas.append({"alvo": alvo, "valor": valor})

    return normalizadas


'''
py = replace_once(py, "def carregar_ordens_executor_persistidas():\n", helper + "def carregar_ordens_executor_persistidas():\n", "helper normalizar apostas")

py = replace_between(
    py,
    "def carregar_ordens_executor_persistidas():",
    "def registrar_ordem_idempotente",
    r'''def carregar_ordens_executor_persistidas():
    caminho = os.path.abspath(EXECUTOR_ORDER_JOURNAL_FILE)
    if not os.path.exists(caminho):
        return 0

    try:
        with open(caminho, "r", encoding="utf-8") as arquivo:
            payload = json.load(arquivo)
    except Exception as e:
        raise RuntimeError(f"Journal de idempotencia do executor ilegivel: {e}") from e

    if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("orders"), list):
        raise RuntimeError("Journal de idempotencia do executor possui formato invalido")

    carregadas = {}
    for item in payload["orders"][-ORDEM_ID_LIMITE_MEMORIA:]:
        if not isinstance(item, dict):
            raise RuntimeError("Journal de idempotencia do executor contem ordem invalida")

        order_id = str(item.get("order_id") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", order_id):
            raise RuntimeError("Journal de idempotencia do executor contem order_id invalido")
        try:
            apostas = normalizar_apostas_recebidas(item)
        except ValueError as e:
            raise RuntimeError(f"Journal de idempotencia do executor contem ordem invalida: {e}") from e

        ordem = {
            "order_id": order_id,
            "alvo": apostas[0]["alvo"],
            "valor": apostas[0]["valor"],
            "apostas": apostas
        }
        existente = carregadas.get(order_id)
        if existente is not None and existente.get("apostas") != apostas:
            raise RuntimeError("Journal de idempotencia do executor contem conflito de order_id")
        carregadas[order_id] = ordem

    with ordens_executor_lock:
        ordens_executor_recebidas.clear()
        ordens_executor_recebidas.update(carregadas)

    return len(carregadas)

''',
    "loader journal composto"
)

py = replace_between(
    py,
    "def registrar_ordem_idempotente(dados, aceitar_nova=True):",
    "ordens_persistidas = carregar_ordens_executor_persistidas()",
    r'''def registrar_ordem_idempotente(dados, aceitar_nova=True):
    order_id = dados["order_id"]
    apostas = normalizar_apostas_recebidas(dados)

    # BUG-018: a ordem é vinculada ao último resultado resolvido observado pelo
    # mesmo coletor. Isso permite esperar a abertura da rodada seguinte sem risco
    # de executar a ordem depois que outra rodada já terminou.
    seq_contexto = max(0, int(globals().get("coletor_seq", 0) or 0))
    estado_contexto = globals().get("estado_mesa", {})
    lock_contexto = globals().get("estado_mesa_lock")
    if lock_contexto is not None:
        with lock_contexto:
            stage_contexto = str(estado_contexto.get("stage") or "")
    else:
        stage_contexto = str(estado_contexto.get("stage") or "") if isinstance(estado_contexto, dict) else ""

    ordem_normalizada = {
        "order_id": order_id,
        "alvo": apostas[0]["alvo"],
        "valor": apostas[0]["valor"],
        "apostas": apostas,
        "sincronizar_janela": True,
        "coletor_seq_aceite": seq_contexto,
        "stage_aceite": stage_contexto
    }

    with ordens_executor_lock:
        existente = ordens_executor_recebidas.get(order_id)
        if existente is not None:
            mesmo_payload = existente.get("apostas") == apostas
            if existente.get("apostas") is None:
                mesmo_payload = (
                    existente.get("alvo") == apostas[0]["alvo"]
                    and float(existente.get("valor")) == apostas[0]["valor"]
                    and len(apostas) == 1
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

        persistir_ordens_executor(novo_estado)
        ordens_executor_recebidas.clear()
        ordens_executor_recebidas.update(novo_estado)
        fila_apostas.put(ordem_normalizada)

    return "nova", ordem_normalizada

''',
    "registrar idempotencia composto"
)

py = replace_between(
    py,
    "@app.route('/apostar', methods=['POST'])",
    "def iniciar_servidor_flask():",
    r'''@app.route('/apostar', methods=['POST'])
def receber_aposta():
    """Recebe uma ordem lógica; ela pode conter principal + proteção Tie."""
    if not requisicao_interna_autorizada():
        return jsonify({"erro": "Nao autorizado"}), 401

    dados = request.get_json(silent=True)
    if not isinstance(dados, dict):
        return jsonify({"erro": "Payload JSON invalido"}), 400

    order_id = str(dados.get("order_id") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", order_id):
        return jsonify({"erro": "order_id invalido"}), 400

    try:
        apostas = normalizar_apostas_recebidas(dados)
    except ValueError as e:
        return jsonify({"erro": str(e)}), 400

    try:
        resultado_idempotencia, ordem = registrar_ordem_idempotente({
            "order_id": order_id,
            "apostas": apostas
        }, aceitar_nova=executor_pronto.is_set())
    except Exception as e:
        print(f"❌ Falha ao persistir idempotencia da ordem {order_id}: {type(e).__name__}: {e}")
        return jsonify({"erro": "Falha ao persistir idempotencia da ordem", "aceita": False}), 503

    if resultado_idempotencia == "conflito":
        return jsonify({"erro": "order_id reutilizado com payload diferente", "aceita": False, "dados": ordem}), 409

    if resultado_idempotencia == "duplicada":
        print(f"\n♻️ ORDEM JA RECEBIDA: {order_id} - fila preservada sem duplicar aposta")
        return jsonify({"status": "Ordem ja recebida; fila preservada", "aceita": True, "duplicada": True, "dados": ordem}), 200

    if resultado_idempotencia == "indisponivel":
        print(f"⚠️ ORDEM RECUSADA SEM ACEITE: {order_id} - Playwright ainda não está pronto")
        return jsonify({"erro": "Executor Playwright nao esta pronto", "aceita": False, "duplicada": False, "dados": ordem}), 503

    resumo = " + ".join(f"R$ {int(p['valor'])} em {p['alvo']}" for p in apostas)
    print(f"\n📥 ORDEM AUTENTICADA DO NODE.JS: {order_id} - Plano: {resumo}")
    return jsonify({"status": "Aposta aceita na fila; aguardando resultado da interacao DOM", "aceita": True, "duplicada": False, "dados": ordem}), 200

''',
    "endpoint composto"
)

py = replace_between(
    py,
    "def localizar_frame_apostavel(page, cliques_necessarios, seletor_alvo):",
    "def aguardar_janela_aposta",
    r'''def localizar_frame_apostavel(page, planos):
    seletores_fichas = []
    seletores_alvos = []
    for plano in planos:
        seletores_fichas.extend(
            f"div[data-role='chip'][data-value='{ficha}']" for ficha, _ in plano["cliques_necessarios"]
        )
        seletores_alvos.append(f"[data-role='{plano['seletor_alvo']}']")

    for frame in page.frames:
        url = str(frame.url or "").lower()
        if not ("evolution" in url or "evocdn" in url or "game" in url):
            continue
        if not all(elemento_apostavel(frame.locator(seletor)) for seletor in set(seletores_fichas)):
            continue
        if not all(elemento_apostavel(frame.locator(seletor)) for seletor in set(seletores_alvos)):
            continue
        return frame
    return None


''',
    "frame composto"
)

# Ajusta assinatura e chamada interna do gate BUG-018.
py = replace_once(
    py,
    "def aguardar_janela_aposta(page, aposta, cliques_necessarios, seletor_alvo):",
    "def aguardar_janela_aposta(page, aposta, planos):",
    "assinatura aguardar janela"
)
py = replace_once(
    py,
    "            frame_jogo = localizar_frame_apostavel(page, cliques_necessarios, seletor_alvo)",
    "            frame_jogo = localizar_frame_apostavel(page, planos)",
    "gate frame composto"
)

py = replace_between(
    py,
    "def executar_aposta_na_tela(page, aposta):",
    "def parsear_valor_monetario(texto):",
    r'''def executar_aposta_na_tela(page, aposta):
    """Pré-valida todas as pernas e só então executa a ordem lógica composta."""
    cliques_alvo = 0
    try:
        mapa_alvos = {
            "PlayerWon": "bacbo-bet-spot-Player",
            "BankerWon": "bacbo-bet-spot-Banker",
            "Tie": "bacbo-bet-spot-Tie"
        }
        fichas_disponiveis = [5000, 2500, 500, 125, 25, 10, 5]
        apostas = normalizar_apostas_recebidas(aposta)
        planos = []

        for perna in apostas:
            alvo_bruto = perna["alvo"]
            valor_total = int(perna["valor"])
            seletor_alvo = mapa_alvos.get(alvo_bruto)
            if not seletor_alvo:
                return {"status": "FALHOU", "motivo": "Alvo não mapeado", "cliques_alvo": 0}

            valor_restante = valor_total
            cliques_necessarios = []
            for ficha in fichas_disponiveis:
                qtd = valor_restante // ficha
                if qtd > 0:
                    cliques_necessarios.append((ficha, qtd))
                    valor_restante %= ficha

            if valor_restante != 0 or not cliques_necessarios:
                print(f"⚠️ Aposta ignorada: R$ {valor_total} não pode ser representado exatamente pelas fichas disponíveis.")
                return {"status": "FALHOU", "motivo": "Valor não representável pelas fichas", "cliques_alvo": 0}

            planos.append({
                "alvo": alvo_bruto,
                "valor": valor_total,
                "seletor_alvo": seletor_alvo,
                "cliques_necessarios": cliques_necessarios
            })

        # BUG-019: principal e proteção Tie precisam estar acionáveis antes do primeiro clique real.
        frame_jogo, bloqueio = aguardar_janela_aposta(page, aposta, planos)
        if bloqueio is not None:
            print(f"⚠️ Ordem não executada: {bloqueio['motivo']}")
            return bloqueio

        for plano in planos:
            alvo_elemento = frame_jogo.locator(f"[data-role='{plano['seletor_alvo']}']").first
            for ficha, qtd in plano["cliques_necessarios"]:
                seletor_ficha = f"div[data-role='chip'][data-value='{ficha}']"
                try:
                    ficha_elemento = frame_jogo.locator(seletor_ficha).first
                    ficha_elemento.click(timeout=2000)
                    page.wait_for_timeout(150)

                    for _ in range(int(qtd)):
                        alvo_elemento.click(timeout=2000)
                        cliques_alvo += 1
                        page.wait_for_timeout(120)
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
                    print(f"⚠️ Falha durante tentativa DOM da ficha {ficha}: {type(e).__name__}: {e}")
                    return {
                        "status": status,
                        "motivo": f"Falha DOM após {cliques_alvo} clique(s) de alvo",
                        "cliques_alvo": cliques_alvo
                    }

        total = sum(p["valor"] for p in planos)
        resumo = " + ".join(f"R$ {p['valor']} {p['alvo']}" for p in planos)
        print(f"🎯 INTERAÇÃO DOM CONCLUÍDA: {resumo}; exposição total R$ {total}; {cliques_alvo} clique(s) de alvo.")
        return {
            "status": "EXECUTADA",
            "motivo": "Plano DOM composto concluído localmente",
            "cliques_alvo": cliques_alvo
        }
    except ValueError as e:
        return {"status": "FALHOU", "motivo": str(e), "cliques_alvo": cliques_alvo}
    except Exception as e:
        status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
        print(f"⚠️ Erro inesperado no executor: {type(e).__name__}: {e}")
        return {
            "status": status,
            "motivo": f"Erro inesperado após {cliques_alvo} clique(s) de alvo",
            "cliques_alvo": cliques_alvo
        }

''',
    "executor DOM composto"
)

py_path.write_text(py, encoding="utf-8")


# ---------------------------------------------------------------------
# Frontend: política VALOR/PERCENTUAL + preview efetivo Direto/G1/G2
# ---------------------------------------------------------------------
html_path = ROOT / "robo-bacbo" / "public" / "dashboard-app.html"
html = html_path.read_text(encoding="utf-8")

anchor_gale = '''                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #333; margin-bottom:15px;">
                        <h4 style="margin:0 0 10px 0; font-size:12px; color:#ffc107; text-transform:uppercase;">Matriz de Multiplicadores (Smart Gale)</h4>'''
protection_html = '''                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #66551a; margin-bottom:15px;">
                        <h4 style="margin:0 0 8px 0; font-size:12px; color:#ffc107; text-transform:uppercase;">Proteção no Empate indicada pelo sinal</h4>
                        <p style="font-size:11px; color:#aaa; margin:0 0 10px 0;">O robô decide se o sinal usa proteção. Aqui você define somente o valor financeiro da perna Tie. O mesmo multiplicador do Gale é aplicado à proteção.</p>
                        <div style="display:flex; gap:15px; flex-wrap:wrap; align-items:end;">
                            <div class="form-group" style="flex:1; min-width:160px;">
                                <label>Calcular proteção por:</label>
                                <select id="at-tie-modo" onchange="toggleProtecaoEmpateAutoTrader()">
                                    <option value="PERCENTUAL">Percentual da entrada</option>
                                    <option value="VALOR">Valor informado</option>
                                </select>
                            </div>
                            <div class="form-group" id="box-at-tie-percent" style="flex:1; min-width:150px;">
                                <label>Percentual do empate (%):</label>
                                <input type="number" id="at-tie-percent" value="" step="0.1" min="0.1" max="100" placeholder="Ex: 5" oninput="atualizarPreviewProtecaoEmpateAutoTrader()">
                            </div>
                            <div class="form-group" id="box-at-tie-valor" style="flex:1; min-width:150px; display:none;">
                                <label>Valor do empate no Direto (R$):</label>
                                <input type="number" id="at-tie-valor" value="" step="5" min="5" placeholder="Ex: 5" oninput="atualizarPreviewProtecaoEmpateAutoTrader()">
                            </div>
                        </div>
                        <div id="at-tie-preview" style="margin-top:10px; padding:8px 10px; background:#111; border-radius:6px; font-size:11px; color:#aaa;">Informe a política para visualizar os valores efetivos.</div>
                    </div>

'''
html = replace_once(html, anchor_gale, protection_html + anchor_gale, "HTML proteção empate")

# Funções de preview antes do toggle de camuflagem.
html = replace_once(
    html,
    "        function toggleConfigCamuflagem() { let modo = document.getElementById('at-camuflagem').value;",
    '''        function arredondarFichaAutoTrader(valor) { let v = Number(valor); if (!Number.isFinite(v) || v <= 0) return 0; let r = Math.round(v / 5) * 5; return r === 0 ? 5 : r; }
        function atualizarPreviewProtecaoEmpateAutoTrader() {
            const modo = document.getElementById('at-tie-modo')?.value || 'PERCENTUAL';
            const stake = Number(document.getElementById('at-stake')?.value) || 0;
            const g1 = Number(document.getElementById('at-gale1')?.value) || 2;
            const g2 = Number(document.getElementById('at-gale2')?.value) || 4;
            const base = modo === 'PERCENTUAL'
                ? stake * ((Number(document.getElementById('at-tie-percent')?.value) || 0) / 100)
                : (Number(document.getElementById('at-tie-valor')?.value) || 0);
            const box = document.getElementById('at-tie-preview');
            if (!box) return;
            if (stake <= 0 || base <= 0) { box.innerText = 'Informe a política para visualizar os valores efetivos.'; return; }
            const p0 = arredondarFichaAutoTrader(stake), t0 = arredondarFichaAutoTrader(base);
            const p1 = arredondarFichaAutoTrader(stake * g1), t1 = arredondarFichaAutoTrader(base * g1);
            const p2 = arredondarFichaAutoTrader(stake * g2), t2 = arredondarFichaAutoTrader(base * g2);
            box.innerHTML = `Valores efetivos após fichas de R$5 — Direto: <strong>Cor R$ ${p0} + Tie R$ ${t0}</strong> | G1: <strong>Cor R$ ${p1} + Tie R$ ${t1}</strong> | G2: <strong>Cor R$ ${p2} + Tie R$ ${t2}</strong>`;
        }
        function toggleProtecaoEmpateAutoTrader() {
            const modo = document.getElementById('at-tie-modo')?.value || 'PERCENTUAL';
            const pct = document.getElementById('box-at-tie-percent');
            const val = document.getElementById('box-at-tie-valor');
            if (pct) pct.style.display = modo === 'PERCENTUAL' ? 'flex' : 'none';
            if (val) val.style.display = modo === 'VALOR' ? 'flex' : 'none';
            atualizarPreviewProtecaoEmpateAutoTrader();
        }
        function toggleConfigCamuflagem() { let modo = document.getElementById('at-camuflagem').value;''',
    "funções UI proteção"
)

# Atualiza preview quando stake/Gales mudarem sem reestruturar o HTML original.
html = replace_once(html, 'id="at-stake" value="10.00" step="5.00" min="5.00"', 'id="at-stake" value="10.00" step="5.00" min="5.00" oninput="atualizarPreviewProtecaoEmpateAutoTrader()"', "oninput stake")
html = replace_once(html, 'id="at-gale1" value="2.0" step="0.1" min="1.0"', 'id="at-gale1" value="2.0" step="0.1" min="1.0" oninput="atualizarPreviewProtecaoEmpateAutoTrader()"', "oninput g1")
html = replace_once(html, 'id="at-gale2" value="4.0" step="0.1" min="1.0"', 'id="at-gale2" value="4.0" step="0.1" min="1.0" oninput="atualizarPreviewProtecaoEmpateAutoTrader()"', "oninput g2")

# Novo formulário: sem percentual econômico arbitrário; usuário precisa informar.
html = replace_once(
    html,
    "            document.getElementById('at-stop-reds').value = \"0\";",
    "            document.getElementById('at-tie-modo').value = 'PERCENTUAL'; document.getElementById('at-tie-percent').value = ''; document.getElementById('at-tie-valor').value = ''; toggleProtecaoEmpateAutoTrader();\n            document.getElementById('at-stop-reds').value = \"0\";",
    "defaults UI tie"
)

# Edição: recupera política persistida.
html = replace_once(
    html,
    "            document.getElementById('at-stop-reds').value = Math.max(0, Number(cf.stop_reds_seguidos) || 0);",
    "            document.getElementById('at-tie-modo').value = String(cf.tie_stake_mode || 'PERCENTUAL').toUpperCase() === 'VALOR' ? 'VALOR' : 'PERCENTUAL'; document.getElementById('at-tie-percent').value = Number(cf.tie_stake_percent) > 0 ? Number(cf.tie_stake_percent) : ''; document.getElementById('at-tie-valor').value = Number(cf.tie_stake_value) > 0 ? Number(cf.tie_stake_value).toFixed(2) : ''; toggleProtecaoEmpateAutoTrader();\n            document.getElementById('at-stop-reds').value = Math.max(0, Number(cf.stop_reds_seguidos) || 0);",
    "edit UI tie"
)

# Validação visual antes do payload.
html = replace_once(
    html,
    "            if (!nome) return alert('Preencha o Nome do Motor.');\n\n            const payload = {",
    "            if (!nome) return alert('Preencha o Nome do Motor.');\n            const ativoAT = document.getElementById('at-ativo').checked;\n            const tieModo = document.getElementById('at-tie-modo').value === 'VALOR' ? 'VALOR' : 'PERCENTUAL';\n            const tiePercent = Number(document.getElementById('at-tie-percent').value) || 0;\n            const tieValor = Number(document.getElementById('at-tie-valor').value) || 0;\n            if (ativoAT && ((tieModo === 'PERCENTUAL' && tiePercent <= 0) || (tieModo === 'VALOR' && tieValor <= 0))) {\n                return alert('Defina a política financeira da proteção no empate antes de ativar o Auto-Trader.');\n            }\n\n            const payload = {",
    "validate UI tie"
)

html = replace_once(
    html,
    "                ativo: document.getElementById('at-ativo').checked,\n                config: {\n                    stake_inicial:",
    "                ativo: ativoAT,\n                config: {\n                    stake_inicial:",
    "use ativoAT"
)

html = replace_once(
    html,
    "                    gale_2_mult: parseFloat(document.getElementById('at-gale2').value) || 4.0,\n                    modo_camuflagem:",
    "                    gale_2_mult: parseFloat(document.getElementById('at-gale2').value) || 4.0,\n                    tie_stake_mode: tieModo,\n                    tie_stake_percent: tiePercent,\n                    tie_stake_value: tieValor,\n                    modo_camuflagem:",
    "payload UI tie"
)

html_path.write_text(html, encoding="utf-8")


# ---------------------------------------------------------------------
# Tests: augment Python pure + Playwright DOM with composite cases
# ---------------------------------------------------------------------
pure_path = ROOT / "robo-sync-pilot" / "tests" / "test_pure_logic.py"
pure = pure_path.read_text(encoding="utf-8")
insert_marker = "if __name__ == \"__main__\":\n"
extra_pure = r'''

class Bug019CompositePayloadTests(unittest.TestCase):
    def test_normaliza_ordem_composta_principal_mais_tie(self):
        apostas = MOD.normalizar_apostas_recebidas({
            "apostas": [
                {"alvo": "PlayerWon", "valor": 20},
                {"alvo": "Tie", "valor": 5}
            ]
        })
        self.assertEqual(apostas, [
            {"alvo": "PlayerWon", "valor": 20.0},
            {"alvo": "Tie", "valor": 5.0}
        ])

    def test_rejeita_valor_nao_representavel_e_alvo_duplicado(self):
        with self.assertRaises(ValueError):
            MOD.normalizar_apostas_recebidas({"apostas": [{"alvo": "PlayerWon", "valor": 7}]})
        with self.assertRaises(ValueError):
            MOD.normalizar_apostas_recebidas({"apostas": [
                {"alvo": "Tie", "valor": 5}, {"alvo": "Tie", "valor": 10}
            ]})

'''
pure = replace_once(pure, insert_marker, extra_pure + insert_marker, "tests pure composite")
pure_path.write_text(pure, encoding="utf-8")

# Playwright: insert one full composite success test before module main.
pw_path = ROOT / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"
pw = pw_path.read_text(encoding="utf-8")
extra_pw = r'''
    def test_bug019_ordem_composta_prevalida_e_executa_principal_mais_tie(self):
        page = self.page
        page.set_content("""
            <iframe id='game'></iframe>
        """)
        frame = page.frames[1]
        frame.set_content("""
            <button data-role='chip' data-value='10'>10</button>
            <button data-role='chip' data-value='5'>5</button>
            <button data-role='bacbo-bet-spot-Player'>Player</button>
            <button data-role='bacbo-bet-spot-Tie'>Tie</button>
            <script>
                window.clicks = [];
                document.querySelector("[data-role='bacbo-bet-spot-Player']").addEventListener('click', () => window.clicks.push('P'));
                document.querySelector("[data-role='bacbo-bet-spot-Tie']").addEventListener('click', () => window.clicks.push('T'));
            </script>
        """)
        # O helper de produção filtra frames por URL; o teste controlado usa o mesmo bypass já aceito nos testes legados.
        frame._impl_obj._initializer["url"] = "https://game.evolution.test/"

        MOD.executor_pronto.set()
        MOD.coletor_seq = 50
        MOD.estado_mesa["stage"] = "Betting"
        ordem = {
            "order_id": "123e4567-e89b-42d3-a456-426614174000",
            "apostas": [
                {"alvo": "PlayerWon", "valor": 10},
                {"alvo": "Tie", "valor": 5}
            ],
            "sincronizar_janela": True,
            "coletor_seq_aceite": 50
        }
        resultado = MOD.executar_aposta_na_tela(page, ordem)
        self.assertEqual(resultado["status"], "EXECUTADA")
        self.assertEqual(frame.evaluate("window.clicks"), ["P", "T"])

'''
pw = replace_once(pw, "if __name__ == \"__main__\":\n", extra_pw + "if __name__ == \"__main__\":\n", "test playwright composite")
pw_path.write_text(pw, encoding="utf-8")


# Docs: registra o risco mitigado e a semântica X:1.
known_path = ROOT / "docs" / "KNOWN_ISSUES.md"
known = known_path.read_text(encoding="utf-8")
known = replace_once(
    known,
    "## Itens mitigados\n",
    "## Itens mitigados\n\n### BUG-019 — Proteção no empate existia no sinal, mas não na execução financeira\n\nStatus: **mitigado**.\n\nO Auto-Trader segue `proteger_empate` da estratégia: sinal sem proteção envia apenas a cor; sinal protegido exige política financeira válida (`PERCENTUAL` ou `VALOR`) e envia uma única ordem lógica composta com principal + Tie. O valor base do Tie recebe os mesmos multiplicadores configurados para G1/G2 e é arredondado para fichas de R$5. O executor pré-valida todas as pernas com `trial=True` antes do primeiro clique; falha posterior a qualquer clique permanece `AMBIGUA`. A auditoria armazena `valor_empate` separadamente e calcula P&L usando a semântica exibida pela mesa (`4:1`, `6:1`, `10:1`, `25:1`, `88:1`), em que X representa lucro líquido por unidade apostada. Em Tie sem proteção, Player/Banker registra perda de 10% da stake da etapa e o sinal segue para o Gale quando aplicável.\n\n",
    "docs BUG019"
)
known_path.write_text(known, encoding="utf-8")

print("BUG-019 aplicado com sucesso")
