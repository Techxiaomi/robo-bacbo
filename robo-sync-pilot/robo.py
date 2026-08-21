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
VERSAO_ROBO = "v1.6.13"
NOME_ATUALIZACAO = "BUG-050 Alvo Seguro + Ciclo Exclusivo"

URL_CASSINO = os.getenv("CASINO_GAME_URL", "")
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))

USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
WEBHOOK_JS = os.getenv("NODE_WEBHOOK_URL", "http://127.0.0.1:3000/receber-sinal")
COLLECTOR_HEALTH_URL = (
    os.getenv("NODE_COLLECTOR_HEALTH_URL", "http://127.0.0.1:3000/collector-health").strip()
    or "http://127.0.0.1:3000/collector-health"
)
COLLECTOR_ROAD_URL = (
    os.getenv("NODE_COLLECTOR_ROAD_URL", "http://127.0.0.1:3000/collector-road").strip()
    or "http://127.0.0.1:3000/collector-road"
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
    _betting_window_timeout_config = float(os.getenv("EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS", "180"))
    # Valores antigos (15/30 s) encerravam a ordem durante a transição normal
    # pós-Resolved. A expiração primária é estrutural (novo Resolved, perda de
    # continuidade ou indisponibilidade); este prazo é apenas um fusível final.
    EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS = (
        _betting_window_timeout_config
        if 60.0 <= _betting_window_timeout_config <= 180.0
        else 180.0
    )
except ValueError:
    EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS = 180.0

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

try:
    EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS = max(
        2.0,
        min(20.0, float(os.getenv("EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS", "8")))
    )
except ValueError:
    EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS = 8.0

try:
    EXECUTOR_BET_ACCEPTANCE_TOLERANCE = max(
        0.01,
        min(1.0, float(os.getenv("EXECUTOR_BET_ACCEPTANCE_TOLERANCE", "0.10")))
    )
except ValueError:
    EXECUTOR_BET_ACCEPTANCE_TOLERANCE = 0.10

try:
    WEBSOCKET_RECONNECT_GRACE_SECONDS = max(
        1.0,
        min(5.0, float(os.getenv("WEBSOCKET_RECONNECT_GRACE_SECONDS", "5")))
    )
except ValueError:
    WEBSOCKET_RECONNECT_GRACE_SECONDS = 5.0

try:
    ROADMAP_RECONCILIATION_MIN_RESULTS = max(
        4,
        min(12, int(os.getenv("ROADMAP_RECONCILIATION_MIN_RESULTS", "6")))
    )
except ValueError:
    ROADMAP_RECONCILIATION_MIN_RESULTS = 6

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
historico_resultados_confirmados_lock = threading.Lock()
historico_resultados_confirmados = []
HISTORICO_RESULTADOS_CONFIRMADOS_LIMITE = 12
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
    resolved_monotonic_contexto = float(globals().get("ultimo_resolved_monotonic", 0.0) or 0.0)
    estado_contexto = globals().get("estado_mesa", {})
    lock_contexto = globals().get("estado_mesa_lock")
    if lock_contexto is not None:
        with lock_contexto:
            stage_contexto = str(estado_contexto.get("stage") or "")
            round_id_contexto = str(estado_contexto.get("round_id") or "")
            round_resolvido_contexto = bool(estado_contexto.get("round_resolvido"))
    else:
        stage_contexto = str(estado_contexto.get("stage") or "") if isinstance(estado_contexto, dict) else ""
        round_id_contexto = str(estado_contexto.get("round_id") or "") if isinstance(estado_contexto, dict) else ""
        round_resolvido_contexto = bool(estado_contexto.get("round_resolvido")) if isinstance(estado_contexto, dict) else False

    ordem_normalizada = {
        "order_id": order_id,
        "alvo": apostas[0]["alvo"],
        "valor": apostas[0]["valor"],
        "apostas": apostas,
        "sincronizar_janela": True,
        "coletor_seq_aceite": seq_contexto,
        "resolved_monotonic_aceite": resolved_monotonic_contexto,
        "stage_aceite": stage_contexto,
        "round_id_aceite": round_id_contexto,
        "round_resolvido_aceite": round_resolvido_contexto
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
    confirmacao = (resultado or {}).get("confirmacao")
    if isinstance(confirmacao, dict):
        payload["confirmacao"] = {
            "confirmada": confirmacao.get("confirmada") is True,
            "metodo": str(confirmacao.get("metodo") or "")[:40],
            "saldo_antes": confirmacao.get("saldo_antes"),
            "saldo_depois": confirmacao.get("saldo_depois"),
            "exposicao_esperada": confirmacao.get("exposicao_esperada"),
            "debito_observado": confirmacao.get("debito_observado"),
            "confirmada_em": confirmacao.get("confirmada_em"),
        }

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
ultimo_resolved_monotonic = 0.0
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


def id_interrupcao_fluxo(snapshot=None):
    estado = snapshot if isinstance(snapshot, dict) else snapshot_interrupcao_fluxo()
    geracao = max(0, int(estado.get("geracao") or 0))
    if geracao <= 0:
        return ""
    return f"{COLETOR_SESSAO}:{geracao}"


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
    interrupcao = snapshot_interrupcao_fluxo()
    payload = {
        "evento": "INTERRUPCAO",
        "motivo": str(motivo or "CONTINUIDADE_INDETERMINADA")[:120],
        "coletor_sessao": COLETOR_SESSAO,
        "coletor_seq": coletor_seq,
        "interrupcao_id": id_interrupcao_fluxo(interrupcao),
        "interrupcao_geracao": interrupcao["geracao"],
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


def normalizar_snapshot_road(dados):
    args = dados.get("args", {}) if isinstance(dados, dict) else {}
    history = args.get("history") if isinstance(args, dict) else None
    if not isinstance(history, list) or not history:
        return None

    mapa_vencedor = {
        "player": "Player",
        "banker": "Banker",
        "tie": "Tie",
    }
    normalizados = []
    for item in history:
        if not isinstance(item, dict):
            return None

        vencedor = mapa_vencedor.get(str(item.get("winner") or "").strip().lower())
        if not vencedor:
            return None

        player_score = item.get("playerScore")
        banker_score = item.get("bankerScore")
        if isinstance(player_score, bool) or isinstance(banker_score, bool):
            return None
        try:
            player_score = int(player_score)
            banker_score = int(banker_score)
        except (TypeError, ValueError):
            return None
        if not 0 <= player_score <= 12 or not 0 <= banker_score <= 12:
            return None

        normalizados.append({
            "winner": vencedor,
            "playerScore": player_score,
            "bankerScore": banker_score,
        })

    return normalizados


def enviar_snapshot_road_node(dados):
    history = normalizar_snapshot_road(dados)
    if not history:
        registrar_erro_limitado(
            "road_snapshot_invalido",
            "⚠️ bacbo.road recebido sem args.history válido; snapshot shadow ignorado.",
            30,
        )
        return False

    payload = {
        "evento": "ROAD_SNAPSHOT",
        "coletor_sessao": COLETOR_SESSAO,
        "timestamp_coleta": int(time.time() * 1000),
        "history": history,
    }
    try:
        resposta = requests.post(
            COLLECTOR_ROAD_URL,
            json=payload,
            headers={"X-Internal-Token": INTERNAL_API_TOKEN},
            timeout=2,
        )
        resposta.raise_for_status()
        return True
    except Exception as e:
        registrar_erro_limitado(
            "collector_road_node",
            f"⚠️ Falha ao enviar snapshot bacbo.road ao Node em Shadow Mode: {type(e).__name__}: {e}",
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


def marcador_resultado(resultado):
    return {
        "PlayerWon": "P",
        "BankerWon": "B",
        "Tie": "T",
        "TieWon": "T",
    }.get(str(resultado or "").strip(), "")


def registrar_resultado_confirmado(resultado):
    marcador = marcador_resultado(resultado)
    if not marcador:
        return []

    with historico_resultados_confirmados_lock:
        historico_resultados_confirmados.append(marcador)
        del historico_resultados_confirmados[:-HISTORICO_RESULTADOS_CONFIRMADOS_LIMITE]
        return list(historico_resultados_confirmados)


def snapshot_resultados_confirmados():
    with historico_resultados_confirmados_lock:
        return list(historico_resultados_confirmados)


def normalizar_marcador_roadmap(valor):
    texto = str(valor or "").lower()
    texto = re.sub(r"[^a-z0-9]+", " ", texto).strip()
    if re.search(r"(?:^| )(?:playerwon|player|jogador|blue)(?: |$)", texto):
        return "P"
    if re.search(r"(?:^| )(?:bankerwon|banker|banca|red)(?: |$)", texto):
        return "B"
    if re.search(r"(?:^| )(?:tie|tiewon|empate|draw|green|yellow)(?: |$)", texto):
        return "T"
    return ""


def reconciliar_trilhas_roadmap(historico_confirmado, trilhas, minimo_resultados):
    minimo = max(4, int(minimo_resultados or 0))
    historico = [m for m in (historico_confirmado or []) if m in {"P", "B", "T"}]
    if len(historico) < minimo:
        return {
            "confirmada": False,
            "motivo": "HISTORICO_LOCAL_INSUFICIENTE",
            "amostra": len(historico),
        }

    cauda = historico[-minimo:]
    for trilha in trilhas or []:
        normalizada = [m for m in trilha if m in {"P", "B", "T"}]
        if len(normalizada) < minimo:
            continue
        for orientacao, ordenada in (("DIRETA", normalizada), ("INVERSA", list(reversed(normalizada)))):
            if ordenada[-minimo:] == cauda:
                return {
                    "confirmada": True,
                    "motivo": "ROADMAP_DOM_CAUSA_COMPATIVEL",
                    "orientacao": orientacao,
                    "amostra": minimo,
                }

    return {
        "confirmada": False,
        "motivo": "ROADMAP_DOM_SEM_CAUSA_COMPATIVEL",
        "amostra": minimo,
    }


def extrair_trilhas_roadmap_dom(page):
    """Extrai somente marcadores P/B/T de contêineres semânticos da roadmap."""
    diagnostico = {"frames": 0, "raizes": 0, "trilhas": 0}
    trilhas = []
    script = """() => {
        const seletorRaizes = [
            '[data-roadmap]', '[data-history]', '[data-results]',
            '[class*="road" i]', '[class*="bead" i]', '[class*="history" i]', '[class*="result" i]'
        ].join(',');
        const seletorItens = '[data-result],[data-outcome],[data-winner],[data-role],[aria-label],[title],[class]';
        const bruto = Array.from(document.querySelectorAll(seletorRaizes));
        const raizes = bruto.filter(raiz => !bruto.some(outra => outra !== raiz && outra.contains(raiz)));
        const marcador = (elemento) => {
            const partes = [
                elemento.getAttribute('data-result'), elemento.getAttribute('data-outcome'),
                elemento.getAttribute('data-winner'), elemento.getAttribute('data-role'),
                elemento.getAttribute('aria-label'), elemento.getAttribute('title'), elemento.getAttribute('class')
            ].filter(Boolean).join(' ').toLowerCase();
            if (/(^|[^a-z])(playerwon|player|jogador|blue)(?=$|[^a-z])/.test(partes)) return 'P';
            if (/(^|[^a-z])(bankerwon|banker|banca|red)(?=$|[^a-z])/.test(partes)) return 'B';
            if (/(^|[^a-z])(tie|tiewon|empate|draw|green|yellow)(?=$|[^a-z])/.test(partes)) return 'T';
            return '';
        };
        const trilhas = [];
        for (const raiz of raizes) {
            const candidatos = Array.from(raiz.querySelectorAll(seletorItens))
                .map(elemento => ({ elemento, marcador: marcador(elemento) }))
                .filter(item => item.marcador);
            const folhas = candidatos.filter(item => !candidatos.some(outra => (
                outra.elemento !== item.elemento
                && item.elemento.contains(outra.elemento)
                && outra.marcador === item.marcador
            )));
            const sequencia = folhas.map(item => item.marcador);
            if (sequencia.length >= 4) trilhas.push(sequencia);
        }
        return { raizes: raizes.length, trilhas };
    }"""

    for frame in getattr(page, "frames", []):
        try:
            resposta = frame.evaluate(script)
            diagnostico["frames"] += 1
            diagnostico["raizes"] += max(0, int(resposta.get("raizes") or 0))
            for trilha in resposta.get("trilhas") or []:
                if isinstance(trilha, list):
                    trilhas.append([str(m) for m in trilha])
        except Exception:
            continue

    diagnostico["trilhas"] = len(trilhas)
    return {"trilhas": trilhas, "diagnostico": diagnostico}


def reconciliar_reconexao_por_roadmap(page, dados):
    game_info = dados.get("args", {}).get("game", {}) if isinstance(dados, dict) else {}
    stage = str(game_info.get("stage") or "").strip()
    if not stage:
        return {"confirmada": False, "motivo": "PLAYER_STATE_SEM_STAGE", "diagnostico": {}}

    # ARCH-ROAD-01: cookies/overlays não podem cegar o fallback visual.
    fechar_popups(page)
    extraido = extrair_trilhas_roadmap_dom(page)
    resultado = reconciliar_trilhas_roadmap(
        snapshot_resultados_confirmados(),
        extraido["trilhas"],
        ROADMAP_RECONCILIATION_MIN_RESULTS,
    )
    resultado["diagnostico"] = extraido["diagnostico"]
    return resultado


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


def snapshot_estado_mesa():
    with estado_mesa_lock:
        return {
            "round_id": str(estado_mesa.get("round_id") or ""),
            "round_resolvido": bool(estado_mesa.get("round_resolvido")),
            "stage": str(estado_mesa.get("stage") or ""),
            "atualizado_em_ms": int(estado_mesa.get("atualizado_em_ms") or 0),
        }


def player_state_reconexao_elegivel(dados):
    """Exige identidade mínima antes de decidir uma reconexão em quarentena."""
    game_info = dados.get("args", {}).get("game", {}) if isinstance(dados, dict) else {}
    stage = str(game_info.get("stage") or "").strip()
    return bool(stage and identidade_rodada_evolution(game_info))


def classificar_reconexao_player_state(estado_anterior, dados, decorrido_segundos, limite_segundos):
    anterior = estado_anterior if isinstance(estado_anterior, dict) else {}
    game_info = dados.get("args", {}).get("game", {}) if isinstance(dados, dict) else {}
    round_anterior = str(anterior.get("round_id") or "").strip()
    round_atual = identidade_rodada_evolution(game_info)
    stage_atual = str(game_info.get("stage") or "").strip()
    decorrido = max(0.0, float(decorrido_segundos or 0.0))
    limite = max(0.0, float(limite_segundos or 0.0))

    if not stage_atual:
        return {"segura": False, "motivo": "RECONEXAO_PLAYER_STATE_SEM_STAGE", "tipo": "AMBIGUA"}
    if not round_anterior or not round_atual:
        return {"segura": False, "motivo": "RECONEXAO_SEM_ROUND_ID", "tipo": "AMBIGUA"}
    if decorrido > limite:
        return {"segura": False, "motivo": "RECONEXAO_FORA_DA_JANELA", "tipo": "AMBIGUA"}
    if round_atual == round_anterior:
        return {"segura": True, "motivo": "MESMA_RODADA", "tipo": "MESMA_RODADA"}
    if bool(anterior.get("round_resolvido")) and stage_atual.lower() != "resolved":
        return {"segura": True, "motivo": "PROXIMA_RODADA_APOS_RESOLVED", "tipo": "PROXIMA_RODADA"}
    return {"segura": False, "motivo": "TROCA_RODADA_DURANTE_RECONEXAO", "tipo": "BURACO_ESTRUTURAL"}


def stage_evolution_apostavel(stage):
    """Permite somente fases pré-dados; o instante financeiro é governado por Resolved+8s."""
    normalizado = re.sub(r"[^a-z]", "", str(stage or "").strip().lower())
    return normalizado in {"waitingforbets", "closingbets", "acceptingbets", "betting"}


def avaliar_contexto_janela_aposta(aposta):
    if not aposta.get("sincronizar_janela"):
        return {
            "estado": "ABERTA", "stage": "", "seq_atual": None, "seq_ordem": None,
            "round_id": "", "round_id_aceite": "", "idade_stage_ms": 0
        }

    seq_ordem = max(0, int(aposta.get("coletor_seq_aceite") or 0))
    seq_atual = max(0, int(globals().get("coletor_seq", 0) or 0))
    with estado_mesa_lock:
        stage = str(estado_mesa.get("stage") or "").strip()
        round_id = str(estado_mesa.get("round_id") or "").strip()
        atualizado_em_ms = max(0, int(estado_mesa.get("atualizado_em_ms") or 0))

    agora_ms = int(time.time() * 1000)
    idade_stage_ms = max(0, agora_ms - atualizado_em_ms) if atualizado_em_ms > 0 else None
    contexto = {
        "estado": "AGUARDAR_STAGE",
        "stage": stage,
        "seq_atual": seq_atual,
        "seq_ordem": seq_ordem,
        "round_id": round_id,
        "round_id_aceite": str(aposta.get("round_id_aceite") or "").strip(),
        "idade_stage_ms": idade_stage_ms,
    }

    if seq_ordem <= 0:
        contexto["estado"] = "SEM_CONTEXTO"
        return contexto
    if seq_atual > seq_ordem:
        contexto["estado"] = "EXPIRADA"
        return contexto
    if seq_atual < seq_ordem:
        contexto["estado"] = "INCONSISTENTE"
        return contexto
    if not stage_evolution_apostavel(stage):
        return contexto

    limite_frescor_ms = int(max(1.0, float(globals().get("COLLECTOR_PLAYER_STATE_STALE_SECONDS", 20.0))) * 1000)
    if idade_stage_ms is None or idade_stage_ms > limite_frescor_ms:
        contexto["estado"] = "AGUARDAR_FRESCOR"
        return contexto

    contexto["estado"] = "ABERTA"
    return contexto


def primeiro_elemento_apostavel(locator, limite=32):
    try:
        quantidade = min(max(0, int(locator.count())), max(1, int(limite)))
    except Exception:
        return None

    for indice in range(quantidade):
        try:
            elemento = locator.nth(indice)
            if not elemento.is_visible():
                continue
            # trial=True executa actionability sem produzir clique financeiro.
            elemento.click(trial=True, timeout=250)
            return elemento
        except Exception:
            continue
    return None


def elemento_apostavel(locator):
    return primeiro_elemento_apostavel(locator) is not None


def primeiro_elemento_dom_visivel(locator, limite=32):
    """Retorna o primeiro elemento DOM visivel sem executar actionability/trial do Playwright."""
    try:
        quantidade = min(max(0, int(locator.count())), max(1, int(limite)))
    except Exception:
        return None
    for indice in range(quantidade):
        try:
            elemento = locator.nth(indice)
            if elemento.is_visible():
                return elemento
        except Exception:
            continue
    return None


def localizar_ficha_apostavel(frame, valor_ficha):
    try:
        candidatos = frame.locator("[data-role='chip'][data-value]")
        estados_dom = candidatos.evaluate_all(
            """elementos => elementos.slice(0, 64).map(el => {
                const classe = String(el.className || '');
                const estado = String(el.getAttribute('data-state') || '').toLowerCase();
                const verdadeiro = valor => String(valor || '').toLowerCase() === 'true';
                const classeSelecionada = /(^|[-_\\s])(selected|active|checked)($|[-_\\s])/i.test(classe);
                return {
                    valor: el.getAttribute('data-value') || '',
                    selecionada: verdadeiro(el.getAttribute('aria-pressed'))
                        || verdadeiro(el.getAttribute('aria-selected'))
                        || verdadeiro(el.getAttribute('data-selected'))
                        || verdadeiro(el.getAttribute('data-is-selected'))
                        || verdadeiro(el.getAttribute('data-active'))
                        || ['selected', 'active', 'checked'].includes(estado)
                        || classeSelecionada
                };
            })"""
        )
    except Exception:
        return None, 0, {"visiveis": 0, "selecionadas": 0, "acionaveis": 0}

    indices_correspondentes = []
    for indice, estado_dom in enumerate(estados_dom or []):
        try:
            valor_bruto = estado_dom.get("valor") if isinstance(estado_dom, dict) else ""
            valor_numerico = float(str(valor_bruto).strip().replace(" ", "").replace(",", "."))
        except Exception:
            continue
        if abs(valor_numerico - float(valor_ficha)) < 0.001:
            indices_correspondentes.append(indice)

    estatisticas = {"visiveis": 0, "selecionadas": 0, "acionaveis": 0}
    for indice in indices_correspondentes:
        candidato = candidatos.nth(indice)
        try:
            if not candidato.is_visible():
                continue
            estatisticas["visiveis"] += 1
            estado_dom = estados_dom[indice] if indice < len(estados_dom) else {}
            if isinstance(estado_dom, dict) and estado_dom.get("selecionada") is True:
                estatisticas["selecionadas"] += 1
                return {
                    "elemento": candidato,
                    "modo": "JA_SELECIONADA",
                }, len(indices_correspondentes), estatisticas
            try:
                candidato.click(trial=True, timeout=250)
                estatisticas["acionaveis"] += 1
                modo = "CLICAR"
            except Exception:
                # Selecionar uma ficha não cria exposição financeira. Se o elemento
                # exato está visível, a tentativa real pode aguardar a estabilidade;
                # os alvos financeiros continuam pré-validados e o stage é revisto
                # após esta seleção, antes de qualquer aposta.
                modo = "CLICAR_AGUARDANDO_ESTABILIDADE"
            return {
                "elemento": candidato,
                "modo": modo,
            }, len(indices_correspondentes), estatisticas
        except Exception:
            continue
    return None, len(indices_correspondentes), estatisticas


def inspecionar_frame_apostavel(frame, planos):
    fichas_requeridas = sorted({
        int(ficha)
        for plano in planos
        for ficha, _ in plano["cliques_necessarios"]
    })
    alvos_requeridos = sorted({
        str(plano["seletor_alvo"])
        for plano in planos
    })
    elementos_fichas = {}
    elementos_alvos = {}
    fichas_encontradas = 0
    fichas_visiveis = 0
    fichas_selecionadas = 0
    fichas_acionaveis = 0
    alvos_encontrados = 0

    for ficha in fichas_requeridas:
        elemento, quantidade, estatisticas = localizar_ficha_apostavel(frame, ficha)
        if quantidade > 0:
            fichas_encontradas += 1
        if estatisticas.get("visiveis", 0) > 0:
            fichas_visiveis += 1
        if estatisticas.get("selecionadas", 0) > 0:
            fichas_selecionadas += 1
        if estatisticas.get("acionaveis", 0) > 0:
            fichas_acionaveis += 1
        if elemento is not None:
            elementos_fichas[ficha] = elemento

    for alvo in alvos_requeridos:
        locator = frame.locator(f"[data-role='{alvo}']")
        try:
            quantidade = max(0, int(locator.count()))
        except Exception:
            quantidade = 0
        if quantidade > 0:
            alvos_encontrados += 1
        # BUG-047: nao usa click(trial=True) no fast path. Presenca + visibilidade
        # bastam para localizar o alvo; o clique financeiro real usa force=True.
        elemento = primeiro_elemento_dom_visivel(locator)
        if elemento is not None:
            elementos_alvos[alvo] = elemento

    diagnostico = {
        "fichas_necessarias": len(fichas_requeridas),
        "fichas_encontradas": fichas_encontradas,
        "fichas_visiveis": fichas_visiveis,
        "fichas_selecionadas": fichas_selecionadas,
        "fichas_acionaveis": fichas_acionaveis,
        "fichas_prontas": len(elementos_fichas),
        "alvos_necessarios": len(alvos_requeridos),
        "alvos_encontrados": alvos_encontrados,
        "alvos_acionaveis": len(elementos_alvos),
    }
    completo = (
        len(elementos_fichas) == len(fichas_requeridas)
        and len(elementos_alvos) == len(alvos_requeridos)
    )
    return {
        "completo": completo,
        "frame": frame,
        "fichas": elementos_fichas,
        "alvos": elementos_alvos,
        "diagnostico": diagnostico,
    }


def localizar_contexto_apostavel(page, planos):
    try:
        frames = list(page.frames)
    except Exception:
        frames = []

    melhor = {
        "frames": len(frames),
        "fichas_necessarias": len({f for p in planos for f, _ in p["cliques_necessarios"]}),
        "fichas_encontradas": 0,
        "fichas_visiveis": 0,
        "fichas_selecionadas": 0,
        "fichas_acionaveis": 0,
        "fichas_prontas": 0,
        "alvos_necessarios": len({p["seletor_alvo"] for p in planos}),
        "alvos_encontrados": 0,
        "alvos_acionaveis": 0,
    }
    melhor_pontuacao = (-1, -1)

    # A identidade da mesa é provada pelos data-role de todas as fichas/alvos,
    # não por palavras frágeis na URL do iframe.
    for frame in frames:
        try:
            inspecao = inspecionar_frame_apostavel(frame, planos)
        except Exception:
            continue
        diagnostico = inspecao["diagnostico"]
        pontuacao = (
            diagnostico["fichas_prontas"] + diagnostico["alvos_acionaveis"],
            diagnostico["fichas_encontradas"] + diagnostico["alvos_encontrados"],
        )
        if pontuacao > melhor_pontuacao:
            melhor_pontuacao = pontuacao
            melhor.update(diagnostico)
        if inspecao["completo"]:
            diagnostico_completo = {"frames": len(frames), **diagnostico}
            inspecao["diagnostico"] = diagnostico_completo
            return inspecao, diagnostico_completo

    return None, melhor


def localizar_frame_apostavel(page, planos):
    contexto_dom, _ = localizar_contexto_apostavel(page, planos)
    return contexto_dom["frame"] if contexto_dom is not None else None


def clicar_superficie_ficha_playwright(page, elemento):
    """Seleciona a ficha imediatamente no fast path, ignorando actionability do Playwright."""
    try:
        elemento.click(force=True, timeout=2000)
        page.wait_for_timeout(150)
        return {"acionada": True, "relacao": "CLIQUE_PLAYWRIGHT_FORCE", "via": "PLAYWRIGHT_CLICK"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no clique forcado da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao(page, ficha_contexto, valor_ficha):
    elemento = ficha_contexto.get("elemento") if isinstance(ficha_contexto, dict) else None
    if elemento is None:
        return {"confirmada": False, "motivo": "elemento da ficha ausente"}
    if ficha_contexto.get("modo") == "JA_SELECIONADA":
        return {"confirmada": True, "via": "JA_SELECIONADA"}

    superficie = clicar_superficie_ficha_playwright(page, elemento)
    if not isinstance(superficie, dict) or superficie.get("acionada") is not True:
        relacao = superficie.get("relacao", "n/a") if isinstance(superficie, dict) else "n/a"
        motivo = superficie.get("motivo", "superfície não acionada") if isinstance(superficie, dict) else "superfície não acionada"
        return {
            "confirmada": False,
            "motivo": f"superfície da ficha não autorizada ({relacao}): {motivo}",
        }

    # Selecionar a ficha não cria exposição financeira. Não há sleep artificial
    # aqui: o caminho crítico deve chegar ao alvo enquanto AcceptingBets ainda está
    # vigente; stage/seq continuam revalidados imediatamente antes do clique financeiro.
    return {
        "confirmada": True,
        "via": f"SUPERFICIE_PLAYWRIGHT_{superficie.get('relacao', 'DOM')}",
    }


def preselecionar_ficha_unica_antes_da_janela(page, planos):
    """Tenta preparar uma única denominação antes da janela; nunca clica alvo financeiro."""
    fichas = sorted({
        int(ficha)
        for plano in (planos or [])
        for ficha, _ in plano.get("cliques_necessarios", [])
    })
    if len(fichas) != 1:
        return {"confirmada": False, "ficha": None, "motivo": "PLANO_MULTIFICHAS"}

    ficha = fichas[0]
    for frame in list(getattr(page, "frames", []) or []):
        ficha_contexto, _, _ = localizar_ficha_apostavel(frame, ficha)
        if ficha_contexto is None:
            continue
        if ficha_contexto.get("modo") == "JA_SELECIONADA":
            return {"confirmada": True, "ficha": ficha, "via": "JA_SELECIONADA"}

        elemento = ficha_contexto.get("elemento")
        if elemento is None:
            continue
        try:
            # Preparação não financeira e oportunista. Usa a mesma física central
            # do caminho principal, sem force=True e sem clicar wrappers.
            superficie = clicar_superficie_ficha_playwright(page, elemento)
            if superficie.get("acionada") is True:
                return {"confirmada": True, "ficha": ficha, "via": "PRESELECAO_CENTRO"}
        except Exception:
            pass
        continue

    return {"confirmada": False, "ficha": ficha, "motivo": "PRESELECAO_INDISPONIVEL"}


def formatar_diagnostico_janela(contexto, diagnostico):
    diag = diagnostico or {}
    idade = contexto.get("idade_stage_ms")
    idade_texto = "n/a" if idade is None else str(int(idade))
    return (
        f"stage={contexto.get('stage') or 'vazio'}, "
        f"seq={contexto.get('seq_atual')}/{contexto.get('seq_ordem')}, "
        f"stage_age_ms={idade_texto}, frames={diag.get('frames', 0)}, "
        f"fichas_prontas={diag.get('fichas_prontas', 0)}/{diag.get('fichas_necessarias', 0)} "
        f"(DOM {diag.get('fichas_encontradas', 0)}, visíveis {diag.get('fichas_visiveis', 0)}, "
        f"selecionadas {diag.get('fichas_selecionadas', 0)}, acionáveis {diag.get('fichas_acionaveis', 0)}), "
        f"alvos={diag.get('alvos_acionaveis', 0)}/{diag.get('alvos_necessarios', 0)} "
        f"(DOM {diag.get('alvos_encontrados', 0)})"
    )


def aguardar_janela_aposta(page, aposta, planos):
    sincronizar = aposta.get("sincronizar_janela") is True
    inicio_espera = time.monotonic()
    prazo = inicio_espera + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS
    resolved_base = float(aposta.get("resolved_monotonic_aceite") or 0.0)
    alvo_temporal = resolved_base + 8.5 if resolved_base > 0 else 0.0
    ultimo_contexto = avaliar_contexto_janela_aposta(aposta)
    ultimo_diagnostico = {}
    ultima_assinatura = None
    ultima_assinatura_dom = None

    # Mantém somente a limpeza preventiva que já se provou necessária na mesa real.
    try:
        seletor_fechar_modal = (
            'button[aria-label="Close"], '
            'button[aria-label="Fechar"], '
            '[class*="close" i]'
        )
        candidatos_fechar = page.locator(seletor_fechar_modal)
        for indice in range(min(candidatos_fechar.count(), 8)):
            fechar = candidatos_fechar.nth(indice)
            if fechar.is_visible():
                fechar.click(force=True, timeout=1200)
                page.wait_for_timeout(1000)
                print("🧹 Interface limpa: modal/overlay preventivo fechado antes da espera financeira.")
                break
    except Exception:
        pass

    if sincronizar:
        if alvo_temporal <= 0:
            return None, {
                "status": "FALHOU",
                "motivo": "Ordem sem relógio monotônico do Resolved de origem; execução bloqueada",
                "cliques_alvo": 0,
            }
        restante_ms = max(0.0, (alvo_temporal - time.monotonic()) * 1000.0)
        print(
            f"⏱️ Ordem {aposta.get('order_id', 'n/a')} sincronizada pelo Resolved: "
            f"janela real alvo em +8500ms; faltam {restante_ms:.0f}ms."
        )

    while True:
        if sincronizar and not executor_pronto.is_set():
            return None, {
                "status": "FALHOU",
                "motivo": "Executor ficou indisponível enquanto aguardava a janela de apostas",
                "cliques_alvo": 0,
            }

        contexto = avaliar_contexto_janela_aposta(aposta)
        ultimo_contexto = contexto
        assinatura = (contexto["estado"], contexto["stage"], contexto["seq_atual"])
        if sincronizar and assinatura != ultima_assinatura:
            print(
                f"🧭 Ordem {aposta.get('order_id', 'n/a')}: estado={contexto['estado']}, "
                f"stage={contexto['stage'] or 'vazio'}, seq={contexto['seq_atual']}/{contexto['seq_ordem']}."
            )
            ultima_assinatura = assinatura

        if contexto["estado"] == "SEM_CONTEXTO":
            return None, {"status": "FALHOU", "motivo": "Ordem sem contexto de rodada do coletor; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "INCONSISTENTE":
            return None, {"status": "FALHOU", "motivo": "Contexto de rodada inconsistente; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "EXPIRADA":
            return None, {"status": "EXPIRADA", "motivo": "Nova rodada foi resolvida antes da execução; ordem descartada sem cliques", "cliques_alvo": 0}

        agora = time.monotonic()
        if alvo_temporal > 0 and agora < alvo_temporal:
            page.wait_for_timeout(min(50, max(1, int((alvo_temporal - agora) * 1000))))
            continue

        # BUG-047: +8s e fase pre-dados sao a autorizacao temporal. Faz uma unica
        # leitura do DOM sem esperar actionability/trial dos alvos. Se os elementos
        # ainda nem existem/nao estao visiveis, falha fechado em vez de chegar atrasado.
        if contexto["estado"] == "ABERTA":
            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)
            decorrido_resolved_ms = (time.monotonic() - resolved_base) * 1000.0 if resolved_base > 0 else 0.0
            if contexto_dom is None:
                diagnostico_texto = formatar_diagnostico_janela(contexto, ultimo_diagnostico)
                return None, {
                    "status": "FALHOU",
                    "motivo": (
                        f"+8.5s atingido sem todos os elementos DOM visiveis; fast path nao aguardou actionability; "
                        f"{diagnostico_texto}"
                    ),
                    "cliques_alvo": 0,
                }
            if sincronizar:
                print(
                    f"⚡ Ordem {aposta.get('order_id', 'n/a')}: fast path liberado em "
                    f"{decorrido_resolved_ms:.0f}ms após Resolved; stage={contexto['stage'] or 'vazio'}; "
                    "DOM presente; ficha em fast path com force=True e alvos financeiros com hit-test seguro."
                )
            return contexto_dom, None

        # FirstDie/SecondDie/.../Confirmation/Resolved nunca passam por estado ABERTA.
        if time.monotonic() >= prazo:
            diagnostico_texto = formatar_diagnostico_janela(ultimo_contexto, ultimo_diagnostico)
            return None, {
                "status": "EXPIRADA",
                "motivo": f"Fusível operacional atingido sem janela segura; {diagnostico_texto}",
                "cliques_alvo": 0,
            }

        page.wait_for_timeout(25)


def resolver_ponto_seguro_alvo(elemento):
    """Encontra um ponto interno cujo hit-test pertence ao alvo financeiro real."""
    try:
        return elemento.evaluate(
            """el => {
                const r = el.getBoundingClientRect();
                if (!r || r.width <= 2 || r.height <= 2) {
                    return {ok:false, motivo:'BOUNDING_BOX_INVALIDO'};
                }
                const pontos = [
                    [0.50,0.50], [0.50,0.35], [0.50,0.65],
                    [0.35,0.50], [0.65,0.50],
                    [0.30,0.30], [0.70,0.30], [0.30,0.70], [0.70,0.70],
                    [0.50,0.22], [0.50,0.78], [0.22,0.50], [0.78,0.50]
                ];
                const resumo = hit => ({
                    tag: hit ? String(hit.tagName || '') : '',
                    role: hit ? String(hit.getAttribute('data-role') || '') : '',
                    cls: hit ? String(hit.className || '').slice(0,120) : ''
                });
                for (const [fx, fy] of pontos) {
                    const vx = r.left + (r.width * fx);
                    const vy = r.top + (r.height * fy);
                    const hit = document.elementFromPoint(vx, vy);
                    if (hit && (hit === el || el.contains(hit))) {
                        return {
                            ok:true,
                            x:r.width * fx,
                            y:r.height * fy,
                            fx, fy,
                            alvo_role:String(el.getAttribute('data-role') || ''),
                            hit:resumo(hit)
                        };
                    }
                }
                const centro = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
                return {
                    ok:false,
                    motivo:'ALVO_COBERTO_NO_HIT_TEST',
                    alvo_role:String(el.getAttribute('data-role') || ''),
                    hit_centro:resumo(centro)
                };
            }"""
        )
    except Exception as erro:
        return {"ok": False, "motivo": f"HIT_TEST_{type(erro).__name__}"}


def clicar_alvo_financeiro_playwright(page, elemento):
    """Clica somente em ponto comprovadamente pertencente ao alvo financeiro."""
    ponto = resolver_ponto_seguro_alvo(elemento)
    if not isinstance(ponto, dict) or ponto.get("ok") is not True:
        return {
            "acionada": False,
            "relacao": "PONTO_SEGURO_INDISPONIVEL",
            "motivo": str((ponto or {}).get("motivo") or "hit-test nao confirmou o alvo"),
            "diagnostico": ponto if isinstance(ponto, dict) else {},
        }
    try:
        # Sem force=True: o ponto ja foi validado por elementFromPoint como pertencente
        # ao alvo. Assim Playwright nao pode transformar um Tie em segundo Player/Banker.
        elemento.click(
            position={"x": float(ponto["x"]), "y": float(ponto["y"])},
            timeout=1200
        )
        page.wait_for_timeout(120)
        return {
            "acionada": True,
            "relacao": "CLIQUE_PLAYWRIGHT_ALVO_SEGURO",
            "diagnostico": ponto,
        }
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"ponto seguro confirmado, mas clique falhou ({type(erro).__name__})",
            "diagnostico": ponto,
        }


def confirmar_aceite_financeiro_aposta(page, saldo_antes, exposicao_esperada):
    """Confirma o aceite pela redução observável do saldo disponível da conta."""
    try:
        saldo_inicial = round(float(saldo_antes), 2)
        exposicao = round(float(exposicao_esperada), 2)
    except (TypeError, ValueError):
        return {
            "confirmada": False,
            "metodo": "SALDO_INDISPONIVEL",
            "motivo": "Saldo anterior ou exposição inválidos",
        }

    if saldo_inicial < 0 or exposicao <= 0:
        return {
            "confirmada": False,
            "metodo": "SALDO_INDISPONIVEL",
            "motivo": "Saldo anterior ou exposição fora do contrato financeiro",
        }

    tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))

    # BUG-046: depois do clique financeiro simples, a Evolution pode levar mais de 2 s para
    # refletir no HTML o débito já processado pelo servidor. Não lê o saldo antes
    # dessa janela mínima para evitar classificar atualização visual tardia como
    # "clique fantasma".
    page.wait_for_timeout(2500)
    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)
    ultimo_saldo = None
    ultimo_debito = None

    while time.monotonic() <= prazo:
        saldo_atual = ler_saldo_atual(page)
        if saldo_atual is not None:
            ultimo_saldo = round(float(saldo_atual), 2)
            ultimo_debito = round(saldo_inicial - ultimo_saldo, 2)
            if abs(ultimo_debito - exposicao) <= tolerancia:
                return {
                    "confirmada": True,
                    "metodo": "SALDO_DEBITADO",
                    "saldo_antes": saldo_inicial,
                    "saldo_depois": ultimo_saldo,
                    "exposicao_esperada": exposicao,
                    "debito_observado": ultimo_debito,
                    "confirmada_em": int(time.time() * 1000),
                }
        page.wait_for_timeout(150)

    if ultimo_saldo is None:
        motivo = "Saldo deixou de ser legível após os cliques financeiros"
    elif abs(float(ultimo_debito or 0.0)) <= tolerancia:
        motivo = "Saldo não sofreu débito adicional para esta perna; a Evolution não comprovou este aceite"
    else:
        motivo = (
            f"Variação de saldo R$ {float(ultimo_debito or 0.0):.2f} divergiu da "
            f"exposição esperada R$ {exposicao:.2f}"
        )

    return {
        "confirmada": False,
        "metodo": "SALDO_NAO_CONFIRMADO",
        "saldo_antes": saldo_inicial,
        "saldo_depois": ultimo_saldo,
        "exposicao_esperada": exposicao,
        "debito_observado": ultimo_debito,
        "confirmada_em": None,
        "motivo": motivo,
    }


def executar_aposta_na_tela(page, aposta):
    """Pré-valida todas as pernas e só então executa a ordem lógica composta."""
    cliques_alvo = 0
    ficha_corrente = None
    confirmacoes_financeiras = []
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

        # BUG-038/040: a leitura do saldo continua fora do caminho crítico, mas a
        # ficha não é mais pré-selecionada antes da abertura. A Evolution anima as
        # fichas no início de AcceptingBets; toda seleção de ficha ocorre somente
        # depois do delay de estabilização de 1500 ms da janela ABERTA.
        saldo_antes = ler_saldo_atual(page)
        if saldo_antes is None:
            return {
                "status": "FALHOU",
                "motivo": (
                    "Saldo real não pôde ser lido antes da aposta; nenhum clique financeiro foi autorizado"
                ),
                "cliques_alvo": 0,
                "confirmacao": {
                    "confirmada": False,
                    "metodo": "SALDO_INDISPONIVEL",
                },
            }

        # BUG-019/040: principal e proteção Tie precisam estar acionáveis antes do
        # primeiro clique financeiro. A ficha será selecionada somente depois que
        # AcceptingBets permanecer ABERTA durante o delay de animação.
        contexto_dom, bloqueio = aguardar_janela_aposta(page, aposta, planos)
        if bloqueio is not None:
            print(f"⚠️ Ordem não executada: {bloqueio['motivo']}")
            return bloqueio

        frame_jogo = contexto_dom["frame"]
        saldo_referencia = round(float(saldo_antes), 2)

        # BUG-049: a principal que funcionou em mesa real saiu em ~8.5s. Em plano
        # composto, executa as duas pernas na mesma janela, mas nao cola os cliques:
        # cada perna relocaliza/revalida o DOM e a ficha, com uma pausa curta entre
        # elas. A confirmacao de saldo continua somente depois de todas as pernas.
        if len(planos) > 1:
            total_composto = float(sum(p["valor"] for p in planos))
            tentativas_compostas = []
            ficha_corrente = None

            for indice_plano, plano in enumerate(planos):
                if aposta.get("sincronizar_janela") is True:
                    contexto_atual = avaliar_contexto_janela_aposta(aposta)
                    if contexto_atual["estado"] != "ABERTA":
                        return {
                            "status": "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA",
                            "motivo": (
                                "Janela estrutural fechou durante o plano composto; "
                                f"stage={contexto_atual['stage'] or 'vazio'}, "
                                f"seq={contexto_atual['seq_atual']}/{contexto_atual['seq_ordem']}"
                            ),
                            "cliques_alvo": cliques_alvo,
                        }

                alvo_elemento = primeiro_elemento_dom_visivel(
                    frame_jogo.locator(f"[data-role='{plano['seletor_alvo']}']")
                )
                if alvo_elemento is None:
                    return {
                        "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                        "motivo": f"Alvo {plano['alvo']} ausente/oculto durante o plano composto",
                        "cliques_alvo": cliques_alvo,
                    }

                for ficha, qtd in plano["cliques_necessarios"]:
                    ficha_contexto, _, _ = localizar_ficha_apostavel(frame_jogo, ficha)
                    if ficha_contexto is None:
                        return {
                            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                            "motivo": f"Ficha R$ {ficha} ausente/oculta durante o plano composto",
                            "cliques_alvo": cliques_alvo,
                        }

                    # A mesma denominacao continua selecionada entre Player/Banker e Tie.
                    # Nao reclica a ficha R$5 entre pernas iguais: o reclick era ruido
                    # desnecessario no intervalo financeiro composto.
                    precisa_selecionar = ficha_corrente != int(ficha)
                    if precisa_selecionar:
                        selecao = selecionar_ficha_com_confirmacao(page, ficha_contexto, ficha)
                        if selecao.get("confirmada") is not True:
                            return {
                                "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                                "motivo": f"Ficha R$ {ficha} nao confirmou selecao antes de {plano['alvo']}: {selecao.get('motivo', 'motivo desconhecido')}",
                                "cliques_alvo": cliques_alvo,
                            }
                        print(
                            f"✅ Ficha R$ {ficha} preparada para {plano['alvo']} "
                            f"({selecao.get('via', 'n/a')})."
                        )
                    ficha_corrente = int(ficha)

                    for _ in range(int(qtd)):
                        if aposta.get("sincronizar_janela") is True:
                            contexto_atual = avaliar_contexto_janela_aposta(aposta)
                            if contexto_atual["estado"] != "ABERTA":
                                return {
                                    "status": "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA",
                                    "motivo": (
                                        "Janela estrutural fechou antes de concluir o plano composto; "
                                        f"stage={contexto_atual['stage'] or 'vazio'}"
                                    ),
                                    "cliques_alvo": cliques_alvo,
                                }

                        alvo_real = clicar_alvo_financeiro_playwright(page, alvo_elemento)
                        if alvo_real.get("acionada") is not True:
                            return {
                                "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                                "motivo": (
                                    f"Falha no clique composto em {plano['alvo']}: "
                                    f"{alvo_real.get('motivo', alvo_real.get('relacao', 'motivo desconhecido'))}"
                                ),
                                "cliques_alvo": cliques_alvo,
                            }
                        cliques_alvo += 1
                        tentativas_compostas.append({
                            "alvo": plano["alvo"],
                            "ficha": int(ficha),
                            "superficie": alvo_real.get("relacao"),
                        })
                        diag_alvo = alvo_real.get("diagnostico") if isinstance(alvo_real, dict) else {}
                        hit_alvo = diag_alvo.get("hit", {}) if isinstance(diag_alvo, dict) else {}
                        print(
                            f"⚡ COMPOSTO: clique {cliques_alvo} enviado para "
                            f"R$ {int(ficha)} {plano['alvo']} via {alvo_real.get('relacao', 'n/a')}; "
                            f"role={diag_alvo.get('alvo_role', 'n/a')}, hit_role={hit_alvo.get('role', '') or 'descendente'}."
                        )

                if indice_plano < len(planos) - 1:
                    page.wait_for_timeout(250)

            confirmacao_composta = confirmar_aceite_financeiro_aposta(
                page, saldo_antes, total_composto
            )
            debito_observado = float(confirmacao_composta.get("debito_observado") or 0.0)
            if confirmacao_composta.get("confirmada") is not True:
                tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))
                if debito_observado > tolerancia and debito_observado < total_composto - tolerancia:
                    motivo = (
                        f"Debito parcial no plano composto: R$ {debito_observado:.2f} de "
                        f"R$ {total_composto:.2f}; uma ou mais pernas nao foram aceitas"
                    )
                elif abs(debito_observado) <= tolerancia:
                    motivo = f"Nenhum debito confirmado no plano composto; esperado R$ {total_composto:.2f}"
                else:
                    motivo = str(confirmacao_composta.get("motivo") or "Debito composto nao confirmado")
                print(f"🚨 {motivo}.")
                return {
                    "status": "AMBIGUA",
                    "motivo": motivo,
                    "cliques_alvo": cliques_alvo,
                    "confirmacao": {
                        **confirmacao_composta,
                        "confirmada": False,
                        "metodo": "SALDO_COMPOSTO_NAO_CONFIRMADO",
                        "pernas_tentadas": tentativas_compostas,
                    },
                }

            print(
                f"✅ PLANO COMPOSTO ACEITO: debito agregado R$ {total_composto:.2f} confirmado; "
                f"saldo R$ {confirmacao_composta['saldo_antes']:.2f} -> "
                f"R$ {confirmacao_composta['saldo_depois']:.2f}."
            )
            confirmacao_composta["pernas_tentadas"] = tentativas_compostas
            return {
                "status": "EXECUTADA",
                "motivo": "Plano composto confirmado por debito agregado do saldo disponivel",
                "cliques_alvo": cliques_alvo,
                "confirmacao": confirmacao_composta,
            }

        for plano in planos:
            alvo_elemento = contexto_dom["alvos"].get(plano["seletor_alvo"])
            if alvo_elemento is None:
                alvo_elemento = primeiro_elemento_dom_visivel(
                    frame_jogo.locator(f"[data-role='{plano['seletor_alvo']}']")
                )
            if alvo_elemento is None:
                status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                return {
                    "status": status,
                    "motivo": f"Alvo {plano['alvo']} deixou de estar presente/visivel antes do clique",
                    "cliques_alvo": cliques_alvo
                }

            for ficha, qtd in plano["cliques_necessarios"]:
                try:
                    if aposta.get("sincronizar_janela") is True:
                        contexto_atual = avaliar_contexto_janela_aposta(aposta)
                        if contexto_atual["estado"] != "ABERTA":
                            status = "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA"
                            return {
                                "status": status,
                                "motivo": (
                                    "Janela estrutural deixou de estar apostável antes da conclusão; "
                                    f"stage={contexto_atual['stage'] or 'vazio'}, "
                                    f"seq={contexto_atual['seq_atual']}/{contexto_atual['seq_ordem']}"
                                ),
                                "cliques_alvo": cliques_alvo
                            }

                    ficha_contexto = contexto_dom["fichas"].get(int(ficha))
                    if ficha_contexto is None:
                        ficha_contexto, _, _ = localizar_ficha_apostavel(frame_jogo, ficha)
                    if ficha_contexto is None:
                        status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                        return {
                            "status": status,
                            "motivo": f"Ficha R$ {ficha} deixou de estar acionável antes do clique",
                            "cliques_alvo": cliques_alvo
                        }
                    precisa_selecionar = (
                        ficha_contexto.get("modo") != "JA_SELECIONADA"
                        and ficha_corrente != int(ficha)
                    )
                    if precisa_selecionar:
                        selecao = selecionar_ficha_com_confirmacao(page, ficha_contexto, ficha)
                        if selecao.get("confirmada") is not True:
                            status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                            return {
                                "status": status,
                                "motivo": f"Ficha R$ {ficha} não confirmou seleção: {selecao.get('motivo', 'motivo desconhecido')}",
                                "cliques_alvo": cliques_alvo,
                            }
                        if str(selecao.get("via") or "").startswith("SUPERFICIE_"):
                            print(
                                f"✅ Ficha R$ {ficha} acionada pela superfície real do Playwright "
                                f"({selecao.get('via')}) antes do clique financeiro."
                            )
                        ficha_corrente = int(ficha)
                    elif ficha_contexto.get("modo") == "JA_SELECIONADA":
                        ficha_corrente = int(ficha)

                    for _ in range(int(qtd)):
                        if aposta.get("sincronizar_janela") is True:
                            contexto_atual = avaliar_contexto_janela_aposta(aposta)
                            if contexto_atual["estado"] != "ABERTA":
                                status = "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA"
                                return {
                                    "status": status,
                                    "motivo": (
                                        "Janela estrutural fechou durante o plano composto; "
                                        f"stage={contexto_atual['stage'] or 'vazio'}, "
                                        f"seq={contexto_atual['seq_atual']}/{contexto_atual['seq_ordem']}"
                                    ),
                                    "cliques_alvo": cliques_alvo
                                }
                        inicio_clique = time.monotonic()
                        alvo_real = clicar_alvo_financeiro_playwright(page, alvo_elemento)
                        if alvo_real.get("acionada") is not True:
                            status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"
                            return {
                                "status": status,
                                "motivo": (
                                    f"Superfície financeira de {plano['alvo']} não foi autorizada: "
                                    f"{alvo_real.get('motivo', alvo_real.get('relacao', 'motivo desconhecido'))}"
                                ),
                                "cliques_alvo": cliques_alvo,
                            }
                        cliques_alvo += 1

                        # BUG-039: cada clique precisa produzir o débito da própria
                        # ficha antes que qualquer outra perna/clique seja autorizado.
                        confirmacao_perna = confirmar_aceite_financeiro_aposta(
                            page, saldo_referencia, float(ficha)
                        )
                        confirmacao_perna["alvo"] = plano["alvo"]
                        confirmacao_perna["ficha"] = int(ficha)
                        confirmacao_perna["superficie"] = alvo_real.get("relacao")
                        confirmacoes_financeiras.append(confirmacao_perna)
                        if confirmacao_perna.get("confirmada") is not True:
                            motivo = str(confirmacao_perna.get("motivo") or "Aceite financeiro da perna não comprovado")
                            print(
                                f"🚨 CLIQUE SEM ACEITE COMPROVADO: R$ {int(ficha)} {plano['alvo']}; "
                                f"superfície={alvo_real.get('relacao', 'n/a')}; {motivo}."
                            )
                            return {
                                "status": "AMBIGUA",
                                "motivo": motivo,
                                "cliques_alvo": cliques_alvo,
                                "confirmacao": {
                                    "confirmada": False,
                                    "metodo": "SALDO_NAO_CONFIRMADO",
                                    "saldo_antes": saldo_antes,
                                    "saldo_depois": confirmacao_perna.get("saldo_depois"),
                                    "exposicao_esperada": sum(p["valor"] for p in planos),
                                    "pernas": confirmacoes_financeiras,
                                },
                            }
                        saldo_referencia = round(float(confirmacao_perna["saldo_depois"]), 2)
                        print(
                            f"✅ PERNA ACEITA: R$ {int(ficha)} {plano['alvo']} via "
                            f"{alvo_real.get('relacao', 'n/a')}; débito confirmado em "
                            f"{(time.monotonic() - inicio_clique) * 1000:.0f}ms; "
                            f"saldo R$ {confirmacao_perna['saldo_antes']:.2f} -> "
                            f"R$ {confirmacao_perna['saldo_depois']:.2f}."
                        )
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
        debito_total = round(float(saldo_antes) - float(saldo_referencia), 2)
        if abs(debito_total - float(total)) > float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE):
            return {
                "status": "AMBIGUA",
                "motivo": (
                    f"Débito agregado R$ {debito_total:.2f} divergiu da exposição esperada R$ {float(total):.2f}"
                ),
                "cliques_alvo": cliques_alvo,
                "confirmacao": {
                    "confirmada": False,
                    "metodo": "SALDO_NAO_CONFIRMADO",
                    "saldo_antes": round(float(saldo_antes), 2),
                    "saldo_depois": round(float(saldo_referencia), 2),
                    "exposicao_esperada": float(total),
                    "debito_observado": debito_total,
                    "pernas": confirmacoes_financeiras,
                },
            }
        confirmacao = {
            "confirmada": True,
            "metodo": "SALDO_DEBITADO",
            "saldo_antes": round(float(saldo_antes), 2),
            "saldo_depois": round(float(saldo_referencia), 2),
            "exposicao_esperada": float(total),
            "debito_observado": debito_total,
            "confirmada_em": int(time.time() * 1000),
            "pernas": confirmacoes_financeiras,
        }

        print(
            f"✅ APOSTA ACEITA PELA EVOLUTION: {resumo}; exposição R$ {total}; "
            f"saldo R$ {confirmacao['saldo_antes']:.2f} -> R$ {confirmacao['saldo_depois']:.2f}."
        )
        return {
            "status": "EXECUTADA",
            "motivo": "Aceite confirmado por débito do saldo disponível",
            "cliques_alvo": cliques_alvo,
            "confirmacao": confirmacao,
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
    global ultimo_tempo_rodada, ultimo_resolved_monotonic, coletor_seq
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

            # BUG-046: este instante é o relógio mestre da próxima janela financeira.
            # A mesa real libera fichas/alvos aproximadamente 8 s após este Resolved.
            ultimo_resolved_monotonic = time.monotonic()

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
                "interrupcao_id": id_interrupcao_fluxo(interrupcao_pendente) if houve_interrupcao else "",
                "interrupcao_geracao": interrupcao_pendente["geracao"] if houve_interrupcao else 0,
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
                registrar_resultado_confirmado(resultado)
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
            "reconexao_preparando": False,
            "reconexao_pendente": None,
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

        def preparar_reconexao_apos_limpeza(origem):
            """Executa a limpeza do modal antes de iniciar o relógio de reconexão."""
            if status_conexao.get("reconexao_pendente") is not None:
                return False
            if status_conexao.get("reconexao_preparando"):
                return False

            executor_pronto.clear()
            estado_anterior = snapshot_estado_mesa()
            status_conexao.update({
                "ws_conectado": False,
                "ws_oficial": None,
                "reconexao_preparando": True,
            })

            modal_clicado = False
            try:
                padrao_continuar = re.compile(r"^\s*(continuar|continue)\s*$", re.IGNORECASE)
                for frame in list(getattr(page, "frames", []) or []):
                    url_frame = str(getattr(frame, "url", "") or "").lower()
                    if not ("evolution" in url_frame or "evocdn" in url_frame or "game" in url_frame):
                        continue
                    try:
                        botoes = frame.get_by_role("button", name=padrao_continuar)
                        quantidade = min(max(0, int(botoes.count())), 8)
                    except Exception:
                        continue
                    for indice in range(quantidade):
                        try:
                            botao = botoes.nth(indice)
                            if not botao.is_visible(timeout=100):
                                continue
                            botao.click(force=True, timeout=1000)
                            modal_clicado = True
                            print("▶️ ANTI-IDLE | botão Continuar do modal Evolution acionado antes da reconexão.")
                            break
                        except Exception:
                            continue
                    if modal_clicado:
                        break
            finally:
                status_conexao["reconexao_preparando"] = False

            status_conexao["reconexao_pendente"] = {
                "iniciada_monotonic": time.monotonic(),
                "estado_anterior": estado_anterior,
                "origem": str(origem or "WEBSOCKET_CLOSE"),
                "modal_continuar_clicado": modal_clicado,
            }
            print(
                f"🔄 {origem}: limpeza DOM concluída (Continuar={'sim' if modal_clicado else 'não encontrado'}); "
                f"agora a continuidade será verificada por até {WEBSOCKET_RECONNECT_GRACE_SECONDS:g}s."
            )
            return True

        def on_web_socket(ws):
            if "evolution" in ws.url.lower() or "evocdn" in ws.url.lower() or "game" in ws.url.lower():
                ws.on("framereceived", lambda texto: capturar_frame(ws, texto))

                def websocket_fechado(_ws):
                    if status_conexao.get("ws_oficial") is not ws:
                        return
                    preparar_reconexao_apos_limpeza("WEBSOCKET_CLOSE")

                ws.on("close", websocket_fechado)

        def capturar_frame(ws, texto):
            try:
                if not texto or not isinstance(texto, str):
                    return
                texto_limpo = re.sub(r'^\d+', '', texto)
                if not texto_limpo:
                    return
                dados = json.loads(texto_limpo)
                if status_conexao.get("reconexao_preparando") and dados.get("type") in {"bacbo.road", "bacbo.playerState"}:
                    return
                if dados.get("type") == "bacbo.road":
                    ws_oficial = status_conexao.get("ws_oficial")
                    if ws_oficial is not None and ws_oficial is not ws:
                        return
                    threading.Thread(
                        target=enviar_snapshot_road_node,
                        args=(dados,),
                        daemon=True,
                    ).start()
                    return
                if dados.get("type") == "bacbo.playerState":
                    ws_oficial = status_conexao.get("ws_oficial")
                    if ws_oficial is not None and ws_oficial is not ws:
                        return
                    reconexao = status_conexao.get("reconexao_pendente")
                    classificacao_reconexao = None
                    if isinstance(reconexao, dict):
                        # A Evolution pode emitir frames transitórios sem roundId ao
                        # abrir um novo socket. Eles não provam continuidade nem
                        # buraco: aguarda o próximo playerState completo até o timeout.
                        if not player_state_reconexao_elegivel(dados):
                            reconciliacao = reconciliar_reconexao_por_roadmap(page, dados)
                            if reconciliacao["confirmada"]:
                                classificacao_reconexao = {
                                    "segura": True,
                                    "motivo": reconciliacao["motivo"],
                                    "tipo": "ROADMAP_DOM",
                                }
                            else:
                                diagnostico = reconciliacao.get("diagnostico") or {}
                                registrar_erro_limitado(
                                    "reconexao_player_state_incompleto",
                                    "⏳ WebSocket em reconexão: aguardando playerState completo ou roadmap "
                                    f"compatível ({reconciliacao['motivo']}; frames={diagnostico.get('frames', 0)}, "
                                    f"raízes={diagnostico.get('raizes', 0)}, trilhas={diagnostico.get('trilhas', 0)}).",
                                    5,
                                )
                                return
                        if classificacao_reconexao is None:
                            decorrido = time.monotonic() - float(reconexao.get("iniciada_monotonic") or 0.0)
                            classificacao_reconexao = classificar_reconexao_player_state(
                                reconexao.get("estado_anterior"),
                                dados,
                                decorrido,
                                WEBSOCKET_RECONNECT_GRACE_SECONDS,
                            )
                    status_conexao.update({
                        "ativa": True,
                        "ws_conectado": True,
                        "ws_oficial": ws,
                        "ultimo_player_state_monotonic": time.monotonic(),
                        "reconexao_pendente": None,
                    })
                    # Atualiza o stage antes de processar Resolved. O POST ao Node pode
                    # gerar uma ordem imediatamente, e ela precisa nascer vinculada a
                    # um estado explicitamente Resolved.
                    motivo_estado = atualizar_estado_mesa_player(dados)
                    motivo_reconexao = ""
                    if classificacao_reconexao is not None:
                        if classificacao_reconexao["segura"]:
                            print(
                                "✅ WebSocket restabelecido com continuidade confirmada "
                                f"({classificacao_reconexao['motivo']}); sessão estatística preservada."
                            )
                        else:
                            motivo_reconexao = classificacao_reconexao["motivo"]

                    motivo_interrupcao = motivo_estado or motivo_reconexao
                    if motivo_interrupcao:
                        executor_pronto.clear()
                        if marcar_interrupcao_fluxo(motivo_interrupcao):
                            print(f"🚨 Continuidade da rodada Evolution inválida ({motivo_interrupcao}).")
                            notificar_interrupcao_node(motivo_interrupcao)
                    processar_resultado(dados)
                    if not snapshot_interrupcao_fluxo()["interrompida"]:
                        executor_pronto.set()
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
                status_conexao["reconexao_preparando"] = False
                status_conexao["reconexao_pendente"] = None
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
                
                # Mantém a sessão saudável indefinidamente. A navegação é reiniciada
                # somente por evidência operacional (WebSocket/stale/login/Playwright),
                # nunca apenas pela idade da conexão.
                while status_conexao["ativa"]:
                    
                    # CÉREBRO DE EXECUÇÃO: Checa a fila de apostas frequentemente
                    for _ in range(20):
                        sincronizar_saldo_com_node(page, estado_saldo)
                        if not fila_apostas.empty():
                            ordem = fila_apostas.get()
                            processar_ordem_executor(page, ordem)
                        # 500ms de polling consumiam uma fração grande da janela
                        # real de aposta. Mantém o event loop responsivo sem busy-wait.
                        page.wait_for_timeout(50)

                        reconexao = status_conexao.get("reconexao_pendente")
                        if isinstance(reconexao, dict):
                            decorrido_reconexao = time.monotonic() - float(reconexao.get("iniciada_monotonic") or 0.0)
                            if decorrido_reconexao >= WEBSOCKET_RECONNECT_GRACE_SECONDS:
                                status_conexao["reconexao_pendente"] = None
                                status_conexao["ativa"] = False
                                motivo = "WEBSOCKET_RECONEXAO_TIMEOUT"
                                if marcar_interrupcao_fluxo(motivo):
                                    print(
                                        "🚨 WebSocket oficial não foi restabelecido com evidência segura após a limpeza do modal; "
                                        "sinais pendentes serão invalidados."
                                    )
                                    notificar_interrupcao_node(motivo)
                                break
                            continue

                        ultimo_player_state = float(status_conexao.get("ultimo_player_state_monotonic") or 0.0)
                        if ultimo_player_state > 0 and time.monotonic() - ultimo_player_state > COLLECTOR_PLAYER_STATE_STALE_SECONDS:
                            preparar_reconexao_apos_limpeza("PLAYER_STATE_STALE")
                            continue

                    if not status_conexao["ativa"]:
                        break
                    
                    # Detecção estritamente reativa: apenas clica se o botão real do modal estiver visível.
                    padrao_continuar = re.compile(r"^\s*(continuar|continue)\s*$", re.IGNORECASE)
                    for frame in page.frames:
                        url_frame = str(getattr(frame, "url", "") or "").lower()
                        if "evolution" in url_frame or "evocdn" in url_frame or "game" in url_frame:
                            try:
                                btn = frame.get_by_role("button", name=padrao_continuar)
                                if btn.count() > 0 and btn.first.is_visible(timeout=100):
                                    btn.first.click(force=True, timeout=1000)
                                    break
                            except Exception:
                                pass
                    
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
