from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from flask import Flask, request, jsonify
import threading
import queue
import time
import re
import json
import requests
import logging
import os
import hmac
import uuid
from env_loader import load_env_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

# ====================================================================
# CONFIGURAÇÕES GERAIS E CONTROLE DE VERSÃO
# ====================================================================
VERSAO_ROBO = "v1.6.1"
NOME_ATUALIZACAO = "Continuidade Estrutural Fail-Closed"

URL_CASSINO = os.getenv("CASINO_GAME_URL", "")
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))

USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
WEBHOOK_JS = os.getenv("NODE_WEBHOOK_URL", "http://127.0.0.1:3000/receber-sinal")
COLLECTOR_HEALTH_URL = (
    os.getenv("NODE_COLLECTOR_HEALTH_URL", "http://127.0.0.1:3000/collector-health").strip()
    or "http://127.0.0.1:3000/collector-health"
)
EXECUTOR_STATUS_URL = (
    os.getenv("NODE_EXECUTOR_STATUS_URL", "http://127.0.0.1:3000/executor-status").strip()
    or "http://127.0.0.1:3000/executor-status"
)
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()
EXECUTOR_HOST = os.getenv("EXECUTOR_HOST", "127.0.0.1").strip() or "127.0.0.1"
EXECUTOR_PORT = int(os.getenv("EXECUTOR_PORT", "5000"))
CASINO_BALANCE_SELECTOR = os.getenv("CASINO_BALANCE_SELECTOR", "").strip()
EXECUTOR_ORDER_JOURNAL_DEFAULT = os.path.join(BASE_DIR, "runtime", "executor_order_ids.json")
EXECUTOR_ORDER_JOURNAL_FILE = (
    os.getenv("EXECUTOR_ORDER_JOURNAL_FILE", EXECUTOR_ORDER_JOURNAL_DEFAULT).strip()
    or EXECUTOR_ORDER_JOURNAL_DEFAULT
)

try:
    EXECUTOR_ORDER_TTL_SECONDS = max(1.0, min(60.0, float(os.getenv("EXECUTOR_ORDER_TTL_SECONDS", "8"))))
except ValueError:
    EXECUTOR_ORDER_TTL_SECONDS = 8.0

try:
    EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS = max(3.0, min(30.0, float(os.getenv("EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS", "15"))))
except ValueError:
    EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS = 15.0

try:
    RESULT_DEDUP_WINDOW_SECONDS = max(0.5, min(10.0, float(os.getenv("RESULT_DEDUP_WINDOW_SECONDS", "3"))))
except ValueError:
    RESULT_DEDUP_WINDOW_SECONDS = 3.0

try:
    COLLECTOR_PLAYER_STATE_STALE_SECONDS = max(
        10.0,
        min(60.0, float(os.getenv("COLLECTOR_PLAYER_STATE_STALE_SECONDS", "20")))
    )
except ValueError:
    COLLECTOR_PLAYER_STATE_STALE_SECONDS = 20.0

try:
    BALANCE_SYNC_INTERVAL_SECONDS = max(0.5, float(os.getenv("BALANCE_SYNC_INTERVAL_SECONDS", "2")))
except ValueError:
    BALANCE_SYNC_INTERVAL_SECONDS = 2.0

try:
    BALANCE_SYNC_HEARTBEAT_SECONDS = max(
        BALANCE_SYNC_INTERVAL_SECONDS,
        float(os.getenv("BALANCE_SYNC_HEARTBEAT_SECONDS", "60"))
    )
except ValueError:
    BALANCE_SYNC_HEARTBEAT_SECONDS = 60.0

if not INTERNAL_API_TOKEN:
    raise RuntimeError("INTERNAL_API_TOKEN nao configurado. Defina o segredo compartilhado no .env antes de iniciar o executor.")

# ====================================================================
# SERVIDOR FLASK (O "Ouvido" do Robô para receber ordens do Node.js)
# ====================================================================
fila_apostas = queue.Queue()
ordens_executor_recebidas = {}
ordens_executor_lock = threading.Lock()
executor_pronto = threading.Event()
estado_mesa_lock = threading.Lock()
estado_mesa = {
    "stage": "",
    "atualizado_em_ms": 0,
    "round_id": "",
    "round_resolvido": False,
}
ORDEM_ID_LIMITE_MEMORIA = 5000
app = Flask(__name__)
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR) # Oculta os logs técnicos do Flask no terminal

def requisicao_interna_autorizada():
    token_recebido = request.headers.get("X-Internal-Token", "")
    return hmac.compare_digest(token_recebido, INTERNAL_API_TOKEN)

def persistir_ordens_executor(estado=None):
    estado_atual = ordens_executor_recebidas if estado is None else estado
    caminho = os.path.abspath(EXECUTOR_ORDER_JOURNAL_FILE)
    diretorio = os.path.dirname(caminho)
    if diretorio:
        os.makedirs(diretorio, exist_ok=True)

    payload = {
        "version": 1,
        "orders": list(estado_atual.values())[-ORDEM_ID_LIMITE_MEMORIA:]
    }
    temporario = f"{caminho}.tmp-{os.getpid()}-{threading.get_ident()}"

    try:
        with open(temporario, "w", encoding="utf-8") as arquivo:
            json.dump(payload, arquivo, ensure_ascii=False, separators=(",", ":"))
            arquivo.flush()
            os.fsync(arquivo.fileno())
        os.replace(temporario, caminho)
    finally:
        if os.path.exists(temporario):
            try:
                os.remove(temporario)
            except OSError:
                pass

def normalizar_apostas_recebidas(dados):
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


def carregar_ordens_executor_persistidas():
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

def registrar_ordem_idempotente(dados, aceitar_nova=True):
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

ordens_persistidas = carregar_ordens_executor_persistidas()
if ordens_persistidas:
    print(f"♻️ Idempotencia restaurada: {ordens_persistidas} order_id(s) carregado(s) do journal.")

@app.route('/apostar', methods=['POST'])
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

def iniciar_servidor_flask():
    app.run(host=EXECUTOR_HOST, port=EXECUTOR_PORT, debug=False, use_reloader=False)

# Inicia o Flask em segundo plano para não travar o robô principal
threading.Thread(target=iniciar_servidor_flask, daemon=True).start()

def ordem_executor_expirada(ordem, agora_ms=None):
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
        if not isinstance(resultado, dict) or resultado.get("status") not in {"EXECUTADA", "FALHOU", "EXPIRADA", "AMBIGUA"}:
            resultado = {
                "status": "AMBIGUA",
                "motivo": "Resultado local da tentativa DOM ficou indeterminado",
                "cliques_alvo": 0
            }

    reportar_status_execucao_node(ordem, resultado)
    return resultado


ultimo_tempo_rodada = 0
COLETOR_SESSAO = str(uuid.uuid4())
coletor_seq = 0
ultimo_resultado_chave = None
ultimo_resultado_chave_em = 0.0
avisos_erro_limitados = {}
continuidade_fluxo_lock = threading.Lock()
continuidade_fluxo = {
    "interrompida": False,
    "motivo": "",
    "geracao": 0,
}

def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
    agora = time.time()
    ultimo = avisos_erro_limitados.get(chave, 0.0)
    if agora - ultimo >= intervalo_segundos:
        print(mensagem)
        avisos_erro_limitados[chave] = agora


def marcar_interrupcao_fluxo(motivo):
    motivo_normalizado = str(motivo or "CONTINUIDADE_INDETERMINADA").strip()[:120]
    with continuidade_fluxo_lock:
        ja_interrompida = continuidade_fluxo["interrompida"]
        continuidade_fluxo["interrompida"] = True
        continuidade_fluxo["motivo"] = motivo_normalizado
        continuidade_fluxo["geracao"] += 1
        return not ja_interrompida


def snapshot_interrupcao_fluxo():
    with continuidade_fluxo_lock:
        return {
            "interrompida": bool(continuidade_fluxo["interrompida"]),
            "motivo": str(continuidade_fluxo["motivo"] or ""),
            "geracao": int(continuidade_fluxo["geracao"]),
        }


def confirmar_interrupcao_reportada(geracao):
    with continuidade_fluxo_lock:
        if not continuidade_fluxo["interrompida"]:
            return False
        if int(geracao) != int(continuidade_fluxo["geracao"]):
            return False
        continuidade_fluxo["interrompida"] = False
        continuidade_fluxo["motivo"] = ""
        return True


def notificar_interrupcao_node(motivo, timestamp_ms=None):
    payload = {
        "evento": "INTERRUPCAO",
        "motivo": str(motivo or "CONTINUIDADE_INDETERMINADA")[:120],
        "coletor_sessao": COLETOR_SESSAO,
        "coletor_seq": coletor_seq,
        "timestamp_coleta": int(timestamp_ms or time.time() * 1000),
    }
    try:
        resposta = requests.post(
            COLLECTOR_HEALTH_URL,
            json=payload,
            headers={"X-Internal-Token": INTERNAL_API_TOKEN},
            timeout=2,
        )
        resposta.raise_for_status()
        return True
    except Exception as e:
        registrar_erro_limitado(
            "collector_health_node",
            f"⚠️ Node não confirmou interrupção do coletor; o próximo resultado continuará lacrado: {type(e).__name__}: {e}",
            30,
        )
        return False


def validar_resultado_resolvido(game_info):
    if not isinstance(game_info, dict):
        raise ValueError("game ausente ou inválido")

    resultado_bruto = str(game_info.get("result") or "").strip()
    if "Tie" in resultado_bruto:
        resultado = "Tie"
    elif resultado_bruto in {"PlayerWon", "BankerWon"}:
        resultado = resultado_bruto
    else:
        raise ValueError(f"vencedor inválido: {resultado_bruto or 'ausente'}")

    dados_recebidos = game_info.get("dice")
    if not isinstance(dados_recebidos, list) or len(dados_recebidos) != 4:
        raise ValueError("resultado deve conter exatamente quatro dados")

    valores_dados = {}
    for dado in dados_recebidos:
        if not isinstance(dado, dict):
            raise ValueError("item de dado inválido")
        identificador = dado.get("id")
        valor = dado.get("value")
        if isinstance(identificador, bool) or isinstance(valor, bool):
            raise ValueError("id/valor booleano não permitido")
        try:
            identificador = int(identificador)
            valor = int(valor)
        except (TypeError, ValueError) as e:
            raise ValueError("id/valor de dado não numérico") from e
        if identificador not in {1, 2, 3, 4} or identificador in valores_dados:
            raise ValueError("IDs dos dados devem ser únicos entre 1 e 4")
        if valor < 1 or valor > 6:
            raise ValueError("valor de dado fora do intervalo 1..6")
        valores_dados[identificador] = valor

    if set(valores_dados) != {1, 2, 3, 4}:
        raise ValueError("conjunto de dados incompleto")

    soma_jogador = valores_dados[1] + valores_dados[3]
    soma_banca = valores_dados[2] + valores_dados[4]
    resultado_coerente = (
        (resultado == "PlayerWon" and soma_jogador > soma_banca)
        or (resultado == "BankerWon" and soma_banca > soma_jogador)
        or (resultado == "Tie" and soma_jogador == soma_banca)
    )
    if not resultado_coerente:
        raise ValueError("vencedor incompatível com os quatro dados")

    return resultado, resultado_bruto, valores_dados

# ====================================================================
# FUNÇÕES CORE DO ROBÔ (Navegação, Login e Apostas)
# ====================================================================
def chave_resultado_resolvido(game_info):
    info = game_info if isinstance(game_info, dict) else {}

    # Prefere uma identidade explícita quando o payload disponibiliza uma.
    for campo in ("roundId", "round_id", "roundID", "roundUid", "round_uid"):
        valor = info.get(campo)
        if valor is not None and str(valor).strip():
            return ("round", campo, str(valor).strip())

    # Fallback curto: vencedor + quatro dados normalizados. A janela temporal
    # impede bloquear uma rodada futura que coincidentemente tenha o mesmo resultado.
    dados_normalizados = []
    for dado in info.get("dice", []) if isinstance(info.get("dice", []), list) else []:
        if not isinstance(dado, dict):
            continue
        identificador = dado.get("id")
        valor = dado.get("value")
        dados_normalizados.append((str(identificador), str(valor)))
    dados_normalizados.sort()

    return (
        "fingerprint",
        str(info.get("result") or ""),
        tuple(dados_normalizados)
    )


def identidade_rodada_evolution(game_info):
    info = game_info if isinstance(game_info, dict) else {}
    for campo in ("roundId", "round_id", "roundID", "roundUid", "round_uid"):
        valor = info.get(campo)
        if valor is not None and str(valor).strip():
            return str(valor).strip()
    return ""


def resultado_resolvido_duplicado(game_info, agora=None):
    global ultimo_resultado_chave, ultimo_resultado_chave_em

    referencia = time.time() if agora is None else float(agora)
    chave = chave_resultado_resolvido(game_info)
    mesma_chave = chave == ultimo_resultado_chave

    if mesma_chave:
        if chave and chave[0] == "round":
            ultimo_resultado_chave_em = referencia
            return True
        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:
            # Janela deslizante: enquanto o mesmo Resolved continuar chegando,
            # ele permanece duplicado. Só uma pausa maior que a janela permite
            # que um fingerprint idêntico seja tratado como nova rodada.
            ultimo_resultado_chave_em = referencia
            return True

    ultimo_resultado_chave = chave
    ultimo_resultado_chave_em = referencia
    return False


def exibir_painel_versao():
    print("="*60)
    print(f"🤖 ROBÔ BAC BO EVOLUTION - MOTOR DE EXECUÇÃO")
    print(f"🏷️ VERSÃO: {VERSAO_ROBO} | {NOME_ATUALIZACAO}")
    print(f"🎧 Escutando ordens autenticadas em {EXECUTOR_HOST}:{EXECUTOR_PORT}...")
    print(f"🧭 Sessão do coletor: {COLETOR_SESSAO}")
    print("="*60)

def aplicar_stealth(page):
    try:
        from playwright_stealth import stealth_sync
        stealth_sync(page)
    except Exception:
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page.add_init_script("window.navigator.chrome = { runtime: {} };")

def fechar_popups(page):
    print("🧹 Limpando pop-ups da tela (Cookies e Maioridade)...")
    page.wait_for_timeout(2000) 
    try:
        btn_cookie = page.locator("button", has_text=re.compile(r"Aceitar todos", re.IGNORECASE))
        for i in range(btn_cookie.count()):
            if btn_cookie.nth(i).is_visible():
                btn_cookie.nth(i).click(force=True)
                page.wait_for_timeout(1000)
                break
    except: pass
    try:
        btn_sim = page.locator("button", has_text=re.compile(r"^Sim$", re.IGNORECASE))
        if btn_sim.count() == 0: 
            btn_sim = page.locator("button", has_text=re.compile(r"Sim", re.IGNORECASE))
        for i in range(btn_sim.count()):
            if btn_sim.nth(i).is_visible():
                btn_sim.nth(i).click(force=True)
                page.wait_for_timeout(1000)
                break
    except: pass

def renovar_sessao_automaticamente(page, context):
    print("\n🔄 Iniciando protocolo de Auto-Login invisível...")
    try:
        page.goto(os.getenv("CASINO_HOME_URL", ""), timeout=60000)
        fechar_popups(page)
        
        botoes_entrar = page.locator("button", has_text=re.compile(r"Entrar", re.IGNORECASE))
        login_aberto = False
        for i in range(botoes_entrar.count()):
            btn = botoes_entrar.nth(i)
            if btn.is_visible():
                try:
                    btn.click(force=True)
                    page.wait_for_timeout(2500)
                    if page.locator("input[name='email']").is_visible():
                        login_aberto = True
                        break
                except: pass
                
        if not login_aberto:
            print("⚠️ Auto-Login não encontrou o formulário de autenticação.")
            return False
            
        page.locator("input[name='email']").fill(USUARIO_CASSINO)
        page.wait_for_timeout(500)
        page.locator("input[name='password']").fill(SENHA_CASSINO)
        page.wait_for_timeout(500)
        
        botao_confirmar = page.locator("button#legitimuz-action-send-analisys")
        if botao_confirmar.is_visible():
            botao_confirmar.click(force=True)
        else:
            page.locator("input[name='password']").press("Enter")
            
        page.wait_for_timeout(6000)
        context.storage_state(path=ARQUIVO_SESSAO)
        print("✅ Auto-Login concluído com sucesso!")
        return True
    except Exception as e:
        registrar_erro_limitado(
            "auto_login",
            f"⚠️ Auto-Login falhou: {type(e).__name__}: {e}",
            30
        )
        return False

def atualizar_estado_mesa_player(dados):
    game_info = dados.get("args", {}).get("game", {}) if isinstance(dados, dict) else {}
    stage = str(game_info.get("stage") or "").strip()
    if not stage:
        return "PLAYER_STATE_SEM_STAGE"

    round_id = identidade_rodada_evolution(game_info)
    motivo_interrupcao = ""

    with estado_mesa_lock:
        round_anterior = str(estado_mesa.get("round_id") or "")
        round_anterior_resolvido = bool(estado_mesa.get("round_resolvido"))

        if round_id and round_anterior and round_id != round_anterior:
            if not round_anterior_resolvido:
                motivo_interrupcao = "TROCA_RODADA_SEM_RESOLVED"
            estado_mesa["round_id"] = round_id
            estado_mesa["round_resolvido"] = False
        elif round_id and not round_anterior:
            estado_mesa["round_id"] = round_id

        if stage.lower() == "resolved" and (round_id or round_anterior):
            estado_mesa["round_resolvido"] = True

        estado_mesa["stage"] = stage
        estado_mesa["atualizado_em_ms"] = int(time.time() * 1000)

    return motivo_interrupcao


def avaliar_contexto_janela_aposta(aposta):
    if not aposta.get("sincronizar_janela"):
        return {"estado": "ABERTA", "stage": "", "seq_atual": None, "seq_ordem": None}

    seq_ordem = max(0, int(aposta.get("coletor_seq_aceite") or 0))
    seq_atual = max(0, int(globals().get("coletor_seq", 0) or 0))
    with estado_mesa_lock:
        stage = str(estado_mesa.get("stage") or "").strip()

    if seq_ordem <= 0:
        return {"estado": "SEM_CONTEXTO", "stage": stage, "seq_atual": seq_atual, "seq_ordem": seq_ordem}
    if seq_atual > seq_ordem:
        return {"estado": "EXPIRADA", "stage": stage, "seq_atual": seq_atual, "seq_ordem": seq_ordem}
    if seq_atual < seq_ordem:
        return {"estado": "INCONSISTENTE", "stage": stage, "seq_atual": seq_atual, "seq_ordem": seq_ordem}
    if not stage or stage.lower() == "resolved":
        return {"estado": "AGUARDAR", "stage": stage, "seq_atual": seq_atual, "seq_ordem": seq_ordem}
    return {"estado": "ABERTA", "stage": stage, "seq_atual": seq_atual, "seq_ordem": seq_ordem}


def elemento_apostavel(locator):
    try:
        if locator.count() <= 0:
            return False
        elemento = locator.first
        if not elemento.is_visible():
            return False
        # trial=True executa as verificações de actionability do Playwright sem
        # efetuar clique financeiro. É o gate DOM antes de qualquer interação real.
        elemento.click(trial=True, timeout=250)
        return True
    except Exception:
        return False


def localizar_frame_apostavel(page, planos):
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


def aguardar_janela_aposta(page, aposta, planos):
    sincronizar = aposta.get("sincronizar_janela") is True
    prazo = time.monotonic() + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS

    if sincronizar:
        print(
            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando janela apostável "
            f"da rodada após coletor_seq={aposta.get('coletor_seq_aceite', 0)}..."
        )

    while True:
        if sincronizar and not executor_pronto.is_set():
            return None, {
                "status": "FALHOU",
                "motivo": "Executor ficou indisponível enquanto aguardava a janela de apostas",
                "cliques_alvo": 0
            }

        contexto = avaliar_contexto_janela_aposta(aposta)
        if contexto["estado"] == "SEM_CONTEXTO":
            return None, {
                "status": "FALHOU",
                "motivo": "Ordem sem contexto de rodada do coletor; execução bloqueada",
                "cliques_alvo": 0
            }
        if contexto["estado"] == "INCONSISTENTE":
            return None, {
                "status": "FALHOU",
                "motivo": "Contexto de rodada inconsistente; execução bloqueada",
                "cliques_alvo": 0
            }
        if contexto["estado"] == "EXPIRADA":
            return None, {
                "status": "EXPIRADA",
                "motivo": "Nova rodada foi resolvida antes da execução; ordem descartada sem cliques",
                "cliques_alvo": 0
            }

        if contexto["estado"] == "ABERTA":
            frame_jogo = localizar_frame_apostavel(page, planos)
            if frame_jogo is not None:
                return frame_jogo, None

        if time.monotonic() >= prazo:
            return None, {
                "status": "EXPIRADA",
                "motivo": f"Janela de apostas não ficou acionável em {EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS:g}s",
                "cliques_alvo": 0
            }

        page.wait_for_timeout(100)


def executar_aposta_na_tela(page, aposta):
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

def parsear_valor_monetario(texto):
    if texto is None:
        return None

    match = re.search(r"-?\d[\d\s.,]*", str(texto).replace("\xa0", " "))
    if not match:
        return None

    bruto = re.sub(r"\s+", "", match.group(0))
    negativo = bruto.startswith("-")
    bruto = bruto.lstrip("-")

    if "," in bruto and "." in bruto:
        if bruto.rfind(",") > bruto.rfind("."):
            bruto = bruto.replace(".", "").replace(",", ".")
        else:
            bruto = bruto.replace(",", "")
    elif "," in bruto:
        esquerda, direita = bruto.rsplit(",", 1)
        bruto = esquerda.replace(",", "") + "." + direita if len(direita) in (1, 2) else bruto.replace(",", "")
    elif "." in bruto:
        esquerda, direita = bruto.rsplit(".", 1)
        bruto = esquerda.replace(".", "") + "." + direita if len(direita) in (1, 2) else bruto.replace(".", "")

    try:
        valor = float(bruto)
    except ValueError:
        return None

    if negativo or valor < 0:
        return None
    return round(valor, 2)


def ler_saldo_atual(page):
    if not CASINO_BALANCE_SELECTOR:
        return None

    contextos = [page] + list(page.frames)
    for contexto in contextos:
        try:
            localizador = contexto.locator(CASINO_BALANCE_SELECTOR)
            limite = min(localizador.count(), 10)
            for indice in range(limite):
                elemento = localizador.nth(indice)
                if not elemento.is_visible():
                    continue
                saldo = parsear_valor_monetario(elemento.inner_text(timeout=700))
                if saldo is not None:
                    return saldo
        except Exception:
            continue

    return None


def sincronizar_saldo_com_node(page, estado_saldo):
    if not CASINO_BALANCE_SELECTOR:
        return

    agora = time.time()
    if agora - estado_saldo["ultima_tentativa"] < BALANCE_SYNC_INTERVAL_SECONDS:
        return
    estado_saldo["ultima_tentativa"] = agora

    saldo = ler_saldo_atual(page)
    if saldo is None:
        if agora - estado_saldo["ultimo_aviso"] >= 60:
            print("⚠️ Saldo não localizado pelo CASINO_BALANCE_SELECTOR configurado.")
            estado_saldo["ultimo_aviso"] = agora
        return

    ultimo_saldo = estado_saldo["ultimo_saldo"]
    mudou = ultimo_saldo is None or abs(saldo - ultimo_saldo) >= 0.005
    heartbeat = agora - estado_saldo["ultimo_envio"] >= BALANCE_SYNC_HEARTBEAT_SECONDS
    if not mudou and not heartbeat:
        return

    payload = {
        "saldo_atual": saldo,
        "timestamp_coleta": int(agora * 1000)
    }

    try:
        resposta = requests.post(
            WEBHOOK_JS,
            json=payload,
            headers={"X-Internal-Token": INTERNAL_API_TOKEN},
            timeout=2
        )
        resposta.raise_for_status()
        estado_saldo["ultimo_saldo"] = saldo
        estado_saldo["ultimo_envio"] = agora
    except Exception as e:
        if agora - estado_saldo["ultimo_erro"] >= 30:
            print(f"⚠️ Falha ao sincronizar saldo com o Node: {e}")
            estado_saldo["ultimo_erro"] = agora


def processar_resultado(dados):
    global ultimo_tempo_rodada, coletor_seq
    try:
        game_info = dados.get("args", {}).get("game", {})
        status_atual = game_info.get("stage")

        if status_atual == "Resolved":
            tempo_atual = time.time()
            try:
                resultado, resultado_bruto, valores_dados = validar_resultado_resolvido(game_info)
            except ValueError as e:
                motivo = "RESULTADO_RESOLVIDO_INVALIDO"
                primeira_marcacao = marcar_interrupcao_fluxo(motivo)
                executor_pronto.clear()
                registrar_erro_limitado(
                    "resultado_resolved_invalido",
                    f"🚨 Resultado Resolved rejeitado; continuidade lacrada: {e}",
                    10,
                )
                if primeira_marcacao:
                    notificar_interrupcao_node(motivo, int(tempo_atual * 1000))
                return

            if resultado_resolvido_duplicado(game_info, tempo_atual):
                registrar_erro_limitado(
                    "resultado_resolved_duplicado",
                    "♻️ Frame Resolved duplicado ignorado sem consumir coletor_seq.",
                    10
                )
                return

            # Consome a sequência somente depois da deduplicação da rodada resolvida.
            # Se parsing ou POST falhar depois daqui, o próximo resultado real deixará
            # um salto observável pelo Node.
            coletor_seq += 1
            seq_atual = coletor_seq
            soma_jogador = valores_dados[1] + valores_dados[3]
            soma_banca = valores_dados[2] + valores_dados[4]

            interrupcao_pendente = snapshot_interrupcao_fluxo()
            intervalo_resultados = tempo_atual - ultimo_tempo_rodada if ultimo_tempo_rodada > 0 else 0
            if intervalo_resultados > 60:
                registrar_erro_limitado(
                    "intervalo_resultados_longo",
                    "⚠️ Intervalo operacional longo entre resultados "
                    f"({intervalo_resultados:.1f}s); continuidade preservada sem evidência estrutural de falha.",
                    30,
                )
            houve_interrupcao = interrupcao_pendente["interrompida"]
            motivo_interrupcao = interrupcao_pendente["motivo"] if houve_interrupcao else ""
            ultimo_tempo_rodada = tempo_atual

            payload = {
                "vencedor": resultado,
                "resultado_bruto": resultado_bruto,
                "pontos_jogador": soma_jogador,
                "pontos_banca": soma_banca,
                "dados_jogador": [valores_dados[1], valores_dados[3]],
                "dados_banca": [valores_dados[2], valores_dados[4]],
                "coletor_sessao": COLETOR_SESSAO,
                "coletor_seq": seq_atual,
                "rodada_origem": identidade_rodada_evolution(game_info),
                "interrupcao_fluxo": houve_interrupcao,
                "motivo_interrupcao": motivo_interrupcao,
                "timestamp_coleta": int(tempo_atual * 1000)
            }

            try:
                resposta = requests.post(
                    WEBHOOK_JS,
                    json=payload,
                    headers={"X-Internal-Token": INTERNAL_API_TOKEN},
                    timeout=2
                )
                resposta.raise_for_status()
                if interrupcao_pendente["interrompida"]:
                    confirmar_interrupcao_reportada(interrupcao_pendente["geracao"])
                executor_pronto.set()
            except Exception as e:
                marcar_interrupcao_fluxo("FALHA_ENVIO_RESULTADO_NODE")
                registrar_erro_limitado(
                    "resultado_node",
                    f"❌ Falha ao enviar resultado resolvido ao Node: {type(e).__name__}: {e}",
                    30
                )

            print("\n====================================")
            if houve_interrupcao:
                print(f"⚠️ [ALERTA] Continuidade interrompida ({motivo_interrupcao or 'DESCONHECIDA'})")
            traducao = {"PlayerWon": "🔵 JOGADOR", "BankerWon": "🔴 BANCA", "Tie": "🟡 EMPATE"}
            print(f"🔥 Vencedor: {traducao.get(resultado, resultado)}")
            print(f"🔵 Jogador : {soma_jogador:02d} | 🔴 Banca: {soma_banca:02d}")
            print("====================================\n")
            
    except Exception as e:
        registrar_erro_limitado(
            "processar_resultado",
            f"❌ Falha ao processar resultado da mesa: {type(e).__name__}: {e}",
            30
        )

def iniciar_robo_blindado():
    executor_pronto.clear()
    with sync_playwright() as p:
        args_camuflagem = [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars', '--no-sandbox', '--disable-dev-shm-usage',
            '--disable-extensions', '--window-size=1366,768'
        ]

        # Modo de operação: Invisível
        browser = p.chromium.launch(headless=True, args=args_camuflagem)
        
        if os.path.exists(ARQUIVO_SESSAO):
            context = browser.new_context(
                storage_state=ARQUIVO_SESSAO,
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions=[] 
            )
        else:
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                permissions=[] 
            )
        
        page = context.new_page()
        aplicar_stealth(page)
        status_conexao = {
            "ativa": True,
            "ws_conectado": False,
            "ws_oficial": None,
            "ultimo_player_state_monotonic": 0.0,
        }
        estado_saldo = {
            "ultima_tentativa": 0.0,
            "ultimo_saldo": None,
            "ultimo_envio": 0.0,
            "ultimo_aviso": 0.0,
            "ultimo_erro": 0.0
        }

        if not CASINO_BALANCE_SELECTOR:
            print("ℹ️ Sincronização de saldo desativada: configure CASINO_BALANCE_SELECTOR no .env.")

        def on_web_socket(ws):
            if "evolution" in ws.url.lower() or "evocdn" in ws.url.lower() or "game" in ws.url.lower():
                ws.on("framereceived", lambda texto: capturar_frame(ws, texto))

                def websocket_fechado(_ws):
                    if status_conexao.get("ws_oficial") is not ws:
                        return
                    executor_pronto.clear()
                    status_conexao.update({
                        "ativa": False,
                        "ws_conectado": False,
                        "ws_oficial": None,
                    })
                    if marcar_interrupcao_fluxo("WEBSOCKET_PLAYER_STATE_FECHADO"):
                        print("🚨 WebSocket oficial da mesa foi fechado; sinais pendentes serão invalidados.")
                        notificar_interrupcao_node("WEBSOCKET_PLAYER_STATE_FECHADO")

                ws.on("close", websocket_fechado)

        def capturar_frame(ws, texto):
            try:
                if not texto or not isinstance(texto, str):
                    return
                texto_limpo = re.sub(r'^\d+', '', texto)
                if not texto_limpo:
                    return
                dados = json.loads(texto_limpo)
                if dados.get("type") == "bacbo.playerState":
                    ws_oficial = status_conexao.get("ws_oficial")
                    if ws_oficial is not None and ws_oficial is not ws:
                        return
                    status_conexao.update({
                        "ativa": True,
                        "ws_conectado": True,
                        "ws_oficial": ws,
                        "ultimo_player_state_monotonic": time.monotonic(),
                    })
                    # Atualiza o stage antes de processar Resolved. O POST ao Node pode
                    # gerar uma ordem imediatamente, e ela precisa nascer vinculada a
                    # um estado explicitamente Resolved.
                    motivo_estado = atualizar_estado_mesa_player(dados)
                    if motivo_estado:
                        executor_pronto.clear()
                        if marcar_interrupcao_fluxo(motivo_estado):
                            print(f"🚨 Continuidade da rodada Evolution inválida ({motivo_estado}).")
                            notificar_interrupcao_node(motivo_estado)
                    processar_resultado(dados)
            except json.JSONDecodeError:
                registrar_erro_limitado(
                    "frame_websocket_json_invalido",
                    "⚠️ Frame WebSocket textual inválido ignorado antes da identificação playerState.",
                    30,
                )
            except Exception as e:
                registrar_erro_limitado(
                    "capturar_frame",
                    f"⚠️ Falha inesperada ao processar frame WebSocket: {type(e).__name__}: {e}",
                    30
                )

        page.on("websocket", on_web_socket)

        while True:
            try:
                executor_pronto.clear()
                status_conexao["ws_conectado"] = False
                status_conexao["ws_oficial"] = None
                status_conexao["ultimo_player_state_monotonic"] = 0.0
                page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
                fechar_popups(page)
                
                sucesso_login = False
                for _ in range(15):
                    if status_conexao["ws_conectado"]:
                        sucesso_login = True
                        break
                    page.wait_for_timeout(1000)
                
                if not sucesso_login:
                    recuperado = renovar_sessao_automaticamente(page, context)
                    if recuperado: continue 
                    else:
                        page.wait_for_timeout(60000)
                        continue

                executor_pronto.set()
                print("✅ Acesso validado! Executor liberado para novas ordens.")
                
                tempo_passado = 0
                while tempo_passado < (2 * 60 * 60 * 1000): # Reinicia a cada 2 horas
                    if not status_conexao["ativa"]: break
                    
                    # CÉREBRO DE EXECUÇÃO: Checa a fila de apostas frequentemente
                    for _ in range(20):
                        sincronizar_saldo_com_node(page, estado_saldo)
                        if not fila_apostas.empty():
                            ordem = fila_apostas.get()
                            processar_ordem_executor(page, ordem)
                        page.wait_for_timeout(500)

                        ultimo_player_state = float(status_conexao.get("ultimo_player_state_monotonic") or 0.0)
                        if ultimo_player_state > 0 and time.monotonic() - ultimo_player_state > COLLECTOR_PLAYER_STATE_STALE_SECONDS:
                            executor_pronto.clear()
                            status_conexao["ativa"] = False
                            if marcar_interrupcao_fluxo("PLAYER_STATE_STALE"):
                                print(
                                    "🚨 Fluxo playerState ficou silencioso por mais de "
                                    f"{COLLECTOR_PLAYER_STATE_STALE_SECONDS:g}s; reiniciando sessão em modo seguro."
                                )
                                notificar_interrupcao_node("PLAYER_STATE_STALE")
                            break

                    if not status_conexao["ativa"]:
                        break
                    
                    # Clica no botão 'Continuar' caso a mesa fique inativa para você
                    for frame in page.frames:
                        if "evolution" in frame.url.lower() or "evocdn" in frame.url.lower() or "game" in frame.url.lower():
                            try:
                                btn = frame.get_by_text(re.compile(r"continuar|continue", re.IGNORECASE))
                                if btn.count() > 0 and btn.first.is_visible(): btn.first.click(force=True)
                            except: pass
                    
                    tempo_passado += 10000

                executor_pronto.clear()
                
            except PlaywrightTimeoutError as e:
                executor_pronto.clear()
                registrar_erro_limitado(
                    "loop_timeout",
                    f"⚠️ Timeout no loop principal do Playwright: {e}",
                    30
                )
                time.sleep(10)
            except Exception as e:
                executor_pronto.clear()
                registrar_erro_limitado(
                    "loop_principal",
                    f"❌ Falha inesperada no loop principal do executor: {type(e).__name__}: {e}",
                    30
                )
                time.sleep(15)

if __name__ == "__main__":
    exibir_painel_versao()
    while True:
        try:
            iniciar_robo_blindado()
        except KeyboardInterrupt:
            executor_pronto.clear()
            print("\n👋 Robô desligado com sucesso.")
            break
        except Exception as e:
            executor_pronto.clear()
            print(f"🔥 Executor reiniciando após falha não tratada: {type(e).__name__}: {e}")
            time.sleep(15)
