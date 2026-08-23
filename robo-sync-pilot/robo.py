from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
import threading
import queue
import time
import re
import json
import requests
import logging
import os

import redis

from env_loader import load_env_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

# ====================================================================
# CONFIGURACOES DO EXECUTOR PURO
# ====================================================================
VERSAO_ROBO = "v1.7.0"
NOME_ATUALIZACAO = "ARCH REDIS - Playwright Executor Puro"


def env_bool(nome, padrao=False):
    valor = str(os.getenv(nome, "true" if padrao else "false")).strip().lower()
    return valor in {"1", "true", "yes", "on", "sim"}


AUTO_TRADER_ENABLED = env_bool("AUTO_TRADER_ENABLED", False)
URL_CASSINO = os.getenv("CASINO_GAME_URL", "").strip()
CASINO_HOME_URL = os.getenv("CASINO_HOME_URL", "").strip()
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))
USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
CASINO_BALANCE_SELECTOR = os.getenv("CASINO_BALANCE_SELECTOR", "").strip()

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0").strip() or "redis://127.0.0.1:6379/0"
REDIS_AUTO_TRADER_COMMANDS_CHANNEL = (
    os.getenv("REDIS_AUTO_TRADER_COMMANDS_CHANNEL", "auto_trader_commands").strip()
    or "auto_trader_commands"
)

EXECUTOR_STATUS_URL = (
    os.getenv("NODE_EXECUTOR_STATUS_URL", "http://127.0.0.1:3000/executor-status").strip()
    or "http://127.0.0.1:3000/executor-status"
)
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()

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
    EXECUTOR_DOM_WAIT_TIMEOUT_SECONDS = max(
        1.0,
        min(30.0, float(os.getenv("EXECUTOR_DOM_WAIT_TIMEOUT_SECONDS", "8")))
    )
except ValueError:
    EXECUTOR_DOM_WAIT_TIMEOUT_SECONDS = 8.0

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

if AUTO_TRADER_ENABLED:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError(
            "INTERNAL_API_TOKEN nao configurado. Defina o segredo compartilhado no .env antes de iniciar o executor."
        )
    if not URL_CASSINO:
        raise RuntimeError("CASINO_GAME_URL nao configurado para o executor Playwright.")

# ====================================================================
# ESTADO DO EXECUTOR / IDEMPOTENCIA
# ====================================================================
fila_apostas = queue.Queue()
ordens_executor_recebidas = {}
ordens_executor_lock = threading.Lock()
executor_pronto = threading.Event()
encerrar_executor = threading.Event()
avisos_erro_limitados = {}
ORDEM_ID_LIMITE_MEMORIA = 5000

logging.getLogger("werkzeug").setLevel(logging.ERROR)


def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
    agora = time.time()
    ultimo = avisos_erro_limitados.get(chave, 0.0)
    if agora - ultimo >= intervalo_segundos:
        print(mensagem)
        avisos_erro_limitados[chave] = agora


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


def normalizar_alvo(valor):
    alvo = str(valor or "").strip().upper()
    mapa = {
        "PLAYER": "PlayerWon",
        "PLAYERWON": "PlayerWon",
        "BANKER": "BankerWon",
        "BANKERWON": "BankerWon",
        "TIE": "Tie",
        "TIEWON": "Tie",
    }
    return mapa.get(alvo, "")


def normalizar_apostas_recebidas(dados):
    if not isinstance(dados, dict):
        raise ValueError("Payload da ordem invalido")

    bruto = dados.get("apostas")
    if bruto is None:
        alvo = dados.get("alvo", dados.get("target"))
        valor = dados.get("valor", dados.get("amount"))
        bruto = [{"alvo": alvo, "valor": valor}]

    if not isinstance(bruto, list) or not 1 <= len(bruto) <= 2:
        raise ValueError("Plano de aposta deve conter uma ou duas pernas")

    normalizadas = []
    alvos = set()
    for perna in bruto:
        if not isinstance(perna, dict):
            raise ValueError("Perna de aposta invalida")
        alvo = normalizar_alvo(perna.get("alvo", perna.get("target")))
        valor_bruto = perna.get("valor", perna.get("amount"))
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

        carregadas[order_id] = {
            "order_id": order_id,
            "alvo": apostas[0]["alvo"],
            "valor": apostas[0]["valor"],
            "apostas": apostas,
            "aceita_em_ms": int(item.get("aceita_em_ms") or 0),
            "sincronizar_janela": False,
        }

    with ordens_executor_lock:
        ordens_executor_recebidas.clear()
        ordens_executor_recebidas.update(carregadas)

    return len(carregadas)


def registrar_ordem_idempotente(dados, aceitar_nova=True):
    order_id = str(dados.get("order_id") or "").strip().lower()
    apostas = normalizar_apostas_recebidas(dados)
    ordem_normalizada = {
        "order_id": order_id,
        "alvo": apostas[0]["alvo"],
        "valor": apostas[0]["valor"],
        "apostas": apostas,
        "sincronizar_janela": False,
    }

    with ordens_executor_lock:
        existente = ordens_executor_recebidas.get(order_id)
        if existente is not None:
            mesmo_payload = existente.get("apostas") == apostas
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

    payload = {
        "order_id": order_id,
        "status": status,
        "motivo": str((resultado or {}).get("motivo") or "").strip()[:300],
    }
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
                timeout=2,
            )
            resposta.raise_for_status()
            return True
        except Exception as e:
            ultimo_erro = e

    registrar_erro_limitado(
        "executor_status_node",
        f"⚠️ Falha ao reportar status {status} da ordem {order_id} ao Node: {type(ultimo_erro).__name__}: {ultimo_erro}",
        30,
    )
    return False


def processar_comando_redis(mensagem):
    try:
        dados = json.loads(str(mensagem or ""))
    except json.JSONDecodeError:
        registrar_erro_limitado(
            "redis_command_json",
            "⚠️ Comando Redis ignorado: JSON invalido.",
            10,
        )
        return

    if not isinstance(dados, dict) or str(dados.get("action") or "").strip().lower() != "place_bet":
        return

    order_id = str(dados.get("order_id") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", order_id):
        registrar_erro_limitado("redis_order_id", "⚠️ Comando Redis ignorado: order_id invalido.", 10)
        return

    try:
        apostas = normalizar_apostas_recebidas(dados)
        resultado_idempotencia, ordem = registrar_ordem_idempotente(
            {"order_id": order_id, "apostas": apostas},
            aceitar_nova=executor_pronto.is_set(),
        )
    except Exception as e:
        print(f"❌ Ordem Redis {order_id} rejeitada: {type(e).__name__}: {e}")
        reportar_status_execucao_node(
            {"order_id": order_id},
            {"status": "FALHOU", "motivo": f"Ordem Redis invalida: {e}"},
        )
        return

    if resultado_idempotencia == "conflito":
        print(f"🚨 ORDEM REDIS EM CONFLITO: {order_id}")
        reportar_status_execucao_node(
            ordem,
            {"status": "FALHOU", "motivo": "order_id reutilizado com payload diferente"},
        )
        return

    if resultado_idempotencia == "indisponivel":
        print(f"⚠️ ORDEM REDIS RECUSADA: {order_id} - Playwright indisponivel")
        reportar_status_execucao_node(
            ordem,
            {"status": "FALHOU", "motivo": "Executor Playwright nao esta pronto"},
        )
        return

    if resultado_idempotencia == "duplicada":
        print(f"♻️ ORDEM REDIS JA RECEBIDA: {order_id} - idempotencia preservada")
        return

    resumo = " + ".join(f"R$ {int(p['valor'])} em {p['alvo']}" for p in apostas)
    print(f"\n📥 ORDEM REDIS AUTENTICADA: {order_id} - Plano: {resumo}")


def ouvir_ordens_redis():
    while not encerrar_executor.is_set():
        cliente = None
        pubsub = None
        try:
            cliente = redis.Redis.from_url(
                REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=None,
                health_check_interval=30,
            )
            cliente.ping()
            pubsub = cliente.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe(REDIS_AUTO_TRADER_COMMANDS_CHANNEL)
            print(f"🎧 Executor inscrito no Redis: {REDIS_AUTO_TRADER_COMMANDS_CHANNEL}")

            for mensagem in pubsub.listen():
                if encerrar_executor.is_set():
                    return
                if not isinstance(mensagem, dict) or mensagem.get("type") != "message":
                    continue
                processar_comando_redis(mensagem.get("data"))
        except Exception as e:
            registrar_erro_limitado(
                "redis_executor",
                f"⚠️ Redis do executor indisponivel; reconectando em 3s: {type(e).__name__}: {e}",
                10,
            )
            time.sleep(3)
        finally:
            try:
                if pubsub is not None:
                    pubsub.close()
            except Exception:
                pass
            try:
                if cliente is not None:
                    cliente.close()
            except Exception:
                pass

# ====================================================================
# NAVEGACAO / LOGIN - SOMENTE EXECUTOR
# ====================================================================
def exibir_painel_versao():
    print("=" * 60)
    print("🤖 ROBÔ BAC BO EVOLUTION - EXECUTOR PURO DE ORDENS")
    print(f"🏷️ VERSÃO: {VERSAO_ROBO} | {NOME_ATUALIZACAO}")
    print(f"📣 Canal Redis: {REDIS_AUTO_TRADER_COMMANDS_CHANNEL}")
    print("=" * 60)


def aplicar_stealth(page):
    try:
        from playwright_stealth import stealth_sync
        stealth_sync(page)
    except Exception:
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page.add_init_script("window.navigator.chrome = { runtime: {} };")


def fechar_popups(page):
    try:
        page.wait_for_timeout(500)
    except Exception:
        return

    try:
        btn_cookie = page.locator("button", has_text=re.compile(r"Aceitar todos", re.IGNORECASE))
        for i in range(min(btn_cookie.count(), 8)):
            if btn_cookie.nth(i).is_visible():
                btn_cookie.nth(i).click(force=True)
                page.wait_for_timeout(300)
                break
    except Exception:
        pass

    try:
        btn_sim = page.locator("button", has_text=re.compile(r"^Sim$|Sim", re.IGNORECASE))
        for i in range(min(btn_sim.count(), 8)):
            if btn_sim.nth(i).is_visible():
                btn_sim.nth(i).click(force=True)
                page.wait_for_timeout(300)
                break
    except Exception:
        pass


def renovar_sessao_automaticamente(page, context):
    if not CASINO_HOME_URL or not USUARIO_CASSINO or not SENHA_CASSINO:
        return False

    print("🔄 Iniciando protocolo de Auto-Login do executor...")
    try:
        page.goto(CASINO_HOME_URL, wait_until="domcontentloaded", timeout=60000)
        fechar_popups(page)

        botoes_entrar = page.locator("button", has_text=re.compile(r"Entrar", re.IGNORECASE))
        login_aberto = False
        for i in range(min(botoes_entrar.count(), 12)):
            btn = botoes_entrar.nth(i)
            if not btn.is_visible():
                continue
            try:
                btn.click(force=True)
                page.wait_for_timeout(1200)
                if page.locator("input[name='email']").is_visible():
                    login_aberto = True
                    break
            except Exception:
                continue

        if not login_aberto:
            return False

        page.locator("input[name='email']").fill(USUARIO_CASSINO)
        page.locator("input[name='password']").fill(SENHA_CASSINO)
        botao_confirmar = page.locator("button#legitimuz-action-send-analisys")
        if botao_confirmar.count() > 0 and botao_confirmar.first.is_visible():
            botao_confirmar.first.click(force=True)
        else:
            page.locator("input[name='password']").press("Enter")

        page.wait_for_timeout(5000)
        context.storage_state(path=ARQUIVO_SESSAO)
        print("✅ Auto-Login concluido.")
        return True
    except Exception as e:
        registrar_erro_limitado("auto_login", f"⚠️ Auto-Login falhou: {type(e).__name__}: {e}", 30)
        return False

# ====================================================================
# DOM DE APOSTAS - SEM LEITURA DE RESULTADOS
# ====================================================================
def primeiro_elemento_dom_visivel(locator, limite=32):
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
                return {
                    valor: el.getAttribute('data-value') || '',
                    selecionada: verdadeiro(el.getAttribute('aria-pressed'))
                        || verdadeiro(el.getAttribute('aria-selected'))
                        || verdadeiro(el.getAttribute('data-selected'))
                        || verdadeiro(el.getAttribute('data-is-selected'))
                        || verdadeiro(el.getAttribute('data-active'))
                        || ['selected', 'active', 'checked'].includes(estado)
                        || /(^|[-_\\s])(selected|active|checked)($|[-_\\s])/i.test(classe)
                };
            })"""
        )
    except Exception:
        return None

    for indice, estado_dom in enumerate(estados_dom or []):
        try:
            valor_numerico = float(str(estado_dom.get("valor") or "").strip().replace(" ", "").replace(",", "."))
        except Exception:
            continue
        if abs(valor_numerico - float(valor_ficha)) >= 0.001:
            continue

        candidato = candidatos.nth(indice)
        try:
            if not candidato.is_visible():
                continue
            if estado_dom.get("selecionada") is True:
                return {"elemento": candidato, "modo": "JA_SELECIONADA"}
            return {"elemento": candidato, "modo": "CLICAR"}
        except Exception:
            continue

    return None


def inspecionar_frame_apostavel(frame, planos):
    fichas_requeridas = sorted({
        int(ficha)
        for plano in planos
        for ficha, _ in plano["cliques_necessarios"]
    })
    alvos_requeridos = sorted({str(plano["seletor_alvo"]) for plano in planos})
    elementos_fichas = {}
    elementos_alvos = {}

    for ficha in fichas_requeridas:
        contexto = localizar_ficha_apostavel(frame, ficha)
        if contexto is not None:
            elementos_fichas[ficha] = contexto

    for alvo in alvos_requeridos:
        elemento = primeiro_elemento_dom_visivel(frame.locator(f"[data-role='{alvo}']"))
        if elemento is not None:
            elementos_alvos[alvo] = elemento

    completo = (
        len(elementos_fichas) == len(fichas_requeridas)
        and len(elementos_alvos) == len(alvos_requeridos)
    )
    return {
        "completo": completo,
        "frame": frame,
        "fichas": elementos_fichas,
        "alvos": elementos_alvos,
    }


def localizar_contexto_apostavel(page, planos):
    try:
        frames = list(page.frames)
    except Exception:
        frames = []

    for frame in frames:
        try:
            inspecao = inspecionar_frame_apostavel(frame, planos)
            if inspecao["completo"]:
                return inspecao
        except Exception:
            continue
    return None


def mesa_execucao_disponivel(page):
    try:
        frames = list(page.frames)
    except Exception:
        return False

    for frame in frames:
        try:
            alvos = frame.locator(
                "[data-role='bacbo-bet-spot-Player'],"
                "[data-role='bacbo-bet-spot-Banker'],"
                "[data-role='bacbo-bet-spot-Tie']"
            )
            fichas = frame.locator("[data-role='chip'][data-value]")
            if alvos.count() > 0 and fichas.count() > 0:
                return True
        except Exception:
            continue
    return False


def selecionar_ficha_com_confirmacao(page, ficha_contexto, valor_ficha):
    elemento = ficha_contexto.get("elemento") if isinstance(ficha_contexto, dict) else None
    if elemento is None:
        return {"confirmada": False, "motivo": "elemento da ficha ausente"}
    if ficha_contexto.get("modo") == "JA_SELECIONADA":
        return {"confirmada": True, "via": "JA_SELECIONADA"}

    try:
        elemento.click(force=True, timeout=1500)
        page.wait_for_timeout(120)
        return {"confirmada": True, "via": "PLAYWRIGHT_FORCE"}
    except Exception as e:
        return {"confirmada": False, "motivo": f"falha ao selecionar ficha R$ {valor_ficha}: {type(e).__name__}"}


def aguardar_contexto_apostavel(page, ordem, planos):
    prazo = time.monotonic() + EXECUTOR_DOM_WAIT_TIMEOUT_SECONDS
    while time.monotonic() <= prazo:
        if not executor_pronto.is_set():
            return None, {
                "status": "FALHOU",
                "motivo": "Executor Playwright ficou indisponivel antes da aposta",
                "cliques_alvo": 0,
            }
        if ordem_executor_expirada(ordem):
            return None, {
                "status": "EXPIRADA",
                "motivo": f"Ordem excedeu TTL de {EXECUTOR_ORDER_TTL_SECONDS:g}s aguardando DOM apostavel",
                "cliques_alvo": 0,
            }

        contexto = localizar_contexto_apostavel(page, planos)
        if contexto is not None:
            return contexto, None
        page.wait_for_timeout(25)

    return None, {
        "status": "FALHOU",
        "motivo": "DOM de apostas nao ficou disponivel dentro da janela do executor",
        "cliques_alvo": 0,
    }


def resolver_ponto_seguro_alvo(elemento):
    try:
        return elemento.evaluate(
            """el => {
                const r = el.getBoundingClientRect();
                if (!r || r.width <= 2 || r.height <= 2) return {ok:false,motivo:'BOUNDING_BOX_INVALIDO'};
                const pontos = [
                    [0.50,0.50],[0.50,0.35],[0.50,0.65],[0.35,0.50],[0.65,0.50],
                    [0.30,0.30],[0.70,0.30],[0.30,0.70],[0.70,0.70]
                ];
                for (const [fx,fy] of pontos) {
                    const vx = r.left + (r.width * fx);
                    const vy = r.top + (r.height * fy);
                    const hit = document.elementFromPoint(vx, vy);
                    if (hit && (hit === el || el.contains(hit))) {
                        return {ok:true,x:r.width*fx,y:r.height*fy,alvo_role:String(el.getAttribute('data-role') || '')};
                    }
                }
                return {ok:false,motivo:'ALVO_COBERTO_NO_HIT_TEST'};
            }"""
        )
    except Exception as e:
        return {"ok": False, "motivo": f"HIT_TEST_{type(e).__name__}"}


def clicar_alvo_financeiro_playwright(page, elemento):
    ponto = resolver_ponto_seguro_alvo(elemento)
    if not isinstance(ponto, dict) or ponto.get("ok") is not True:
        return {
            "acionada": False,
            "motivo": str((ponto or {}).get("motivo") or "hit-test nao confirmou o alvo"),
        }

    try:
        elemento.click(
            position={"x": float(ponto["x"]), "y": float(ponto["y"])},
            timeout=1200,
        )
        page.wait_for_timeout(120)
        return {"acionada": True, "relacao": "CLIQUE_PLAYWRIGHT_ALVO_SEGURO"}
    except Exception as e:
        return {"acionada": False, "motivo": f"clique financeiro falhou ({type(e).__name__})"}


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
            for indice in range(min(localizador.count(), 10)):
                elemento = localizador.nth(indice)
                if not elemento.is_visible():
                    continue
                saldo = parsear_valor_monetario(elemento.inner_text(timeout=700))
                if saldo is not None:
                    return saldo
        except Exception:
            continue
    return None


def confirmar_aceite_financeiro_aposta(page, saldo_antes, exposicao_esperada):
    try:
        saldo_inicial = round(float(saldo_antes), 2)
        exposicao = round(float(exposicao_esperada), 2)
    except (TypeError, ValueError):
        return {"confirmada": False, "metodo": "SALDO_INDISPONIVEL", "motivo": "Saldo/exposicao invalidos"}

    if saldo_inicial < 0 or exposicao <= 0:
        return {"confirmada": False, "metodo": "SALDO_INDISPONIVEL", "motivo": "Saldo/exposicao fora do contrato"}

    tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))
    page.wait_for_timeout(2500)
    prazo = time.monotonic() + EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS
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

    return {
        "confirmada": False,
        "metodo": "SALDO_NAO_CONFIRMADO",
        "saldo_antes": saldo_inicial,
        "saldo_depois": ultimo_saldo,
        "exposicao_esperada": exposicao,
        "debito_observado": ultimo_debito,
        "confirmada_em": None,
        "motivo": "Debito da aposta nao foi comprovado no saldo disponivel",
    }


def executar_aposta_na_tela(page, aposta):
    cliques_alvo = 0
    try:
        mapa_alvos = {
            "PlayerWon": "bacbo-bet-spot-Player",
            "BankerWon": "bacbo-bet-spot-Banker",
            "Tie": "bacbo-bet-spot-Tie",
        }
        fichas_disponiveis = [5000, 2500, 500, 125, 25, 10, 5]
        apostas = normalizar_apostas_recebidas(aposta)
        planos = []

        for perna in apostas:
            alvo = perna["alvo"]
            valor_total = int(perna["valor"])
            seletor_alvo = mapa_alvos.get(alvo)
            if not seletor_alvo:
                return {"status": "FALHOU", "motivo": "Alvo nao mapeado", "cliques_alvo": 0}

            restante = valor_total
            cliques = []
            for ficha in fichas_disponiveis:
                qtd = restante // ficha
                if qtd > 0:
                    cliques.append((ficha, qtd))
                    restante %= ficha
            if restante != 0 or not cliques:
                return {"status": "FALHOU", "motivo": "Valor nao representavel pelas fichas", "cliques_alvo": 0}

            planos.append({
                "alvo": alvo,
                "valor": valor_total,
                "seletor_alvo": seletor_alvo,
                "cliques_necessarios": cliques,
            })

        saldo_antes = ler_saldo_atual(page)
        if saldo_antes is None:
            return {
                "status": "FALHOU",
                "motivo": "Saldo real nao pode ser lido antes da aposta",
                "cliques_alvo": 0,
                "confirmacao": {"confirmada": False, "metodo": "SALDO_INDISPONIVEL"},
            }

        contexto_dom, bloqueio = aguardar_contexto_apostavel(page, aposta, planos)
        if bloqueio is not None:
            return bloqueio

        frame_jogo = contexto_dom["frame"]
        ficha_corrente = None
        total_exposicao = float(sum(plano["valor"] for plano in planos))

        for plano in planos:
            alvo_elemento = primeiro_elemento_dom_visivel(
                frame_jogo.locator(f"[data-role='{plano['seletor_alvo']}']")
            )
            if alvo_elemento is None:
                return {
                    "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                    "motivo": f"Alvo {plano['alvo']} deixou de estar visivel",
                    "cliques_alvo": cliques_alvo,
                }

            for ficha, qtd in plano["cliques_necessarios"]:
                if ordem_executor_expirada(aposta):
                    return {
                        "status": "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA",
                        "motivo": "TTL da ordem venceu durante a execucao",
                        "cliques_alvo": cliques_alvo,
                    }

                contexto_ficha = localizar_ficha_apostavel(frame_jogo, ficha)
                if contexto_ficha is None:
                    return {
                        "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                        "motivo": f"Ficha R$ {ficha} indisponivel",
                        "cliques_alvo": cliques_alvo,
                    }

                if ficha_corrente != int(ficha) and contexto_ficha.get("modo") != "JA_SELECIONADA":
                    selecao = selecionar_ficha_com_confirmacao(page, contexto_ficha, ficha)
                    if selecao.get("confirmada") is not True:
                        return {
                            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                            "motivo": selecao.get("motivo", "Ficha nao selecionada"),
                            "cliques_alvo": cliques_alvo,
                        }
                ficha_corrente = int(ficha)

                for _ in range(int(qtd)):
                    clique = clicar_alvo_financeiro_playwright(page, alvo_elemento)
                    if clique.get("acionada") is not True:
                        return {
                            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
                            "motivo": clique.get("motivo", "Clique financeiro nao autorizado"),
                            "cliques_alvo": cliques_alvo,
                        }
                    cliques_alvo += 1

                if len(planos) > 1:
                    page.wait_for_timeout(200)

        confirmacao = confirmar_aceite_financeiro_aposta(page, saldo_antes, total_exposicao)
        if confirmacao.get("confirmada") is not True:
            return {
                "status": "AMBIGUA",
                "motivo": str(confirmacao.get("motivo") or "Debito financeiro nao confirmado"),
                "cliques_alvo": cliques_alvo,
                "confirmacao": confirmacao,
            }

        resumo = " + ".join(f"R$ {p['valor']} {p['alvo']}" for p in planos)
        print(
            f"✅ APOSTA ACEITA PELA EVOLUTION: {resumo}; "
            f"debito R$ {confirmacao['debito_observado']:.2f} confirmado."
        )
        return {
            "status": "EXECUTADA",
            "motivo": "Aceite confirmado por debito do saldo disponivel",
            "cliques_alvo": cliques_alvo,
            "confirmacao": confirmacao,
        }
    except PlaywrightTimeoutError as e:
        return {
            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
            "motivo": f"Timeout Playwright apos {cliques_alvo} clique(s): {e}",
            "cliques_alvo": cliques_alvo,
        }
    except ValueError as e:
        return {"status": "FALHOU", "motivo": str(e), "cliques_alvo": cliques_alvo}
    except Exception as e:
        return {
            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",
            "motivo": f"Falha inesperada do executor apos {cliques_alvo} clique(s): {type(e).__name__}: {e}",
            "cliques_alvo": cliques_alvo,
        }


def processar_ordem_executor(page, ordem):
    if ordem_executor_expirada(ordem):
        resultado = {
            "status": "EXPIRADA",
            "motivo": f"Ordem excedeu TTL de {EXECUTOR_ORDER_TTL_SECONDS:g}s antes da interacao DOM",
            "cliques_alvo": 0,
        }
    elif not executor_pronto.is_set():
        resultado = {
            "status": "FALHOU",
            "motivo": "Executor ficou indisponivel antes da interacao DOM",
            "cliques_alvo": 0,
        }
    else:
        resultado = executar_aposta_na_tela(page, ordem)

    if not isinstance(resultado, dict) or resultado.get("status") not in {"EXECUTADA", "FALHOU", "EXPIRADA", "AMBIGUA"}:
        resultado = {
            "status": "AMBIGUA",
            "motivo": "Resultado local da tentativa DOM ficou indeterminado",
            "cliques_alvo": 0,
        }

    reportar_status_execucao_node(ordem, resultado)
    return resultado

# ====================================================================
# CICLO DO PLAYWRIGHT - SEM WEBSOCKET / PLAYERSTATE / ROAD
# ====================================================================
def preparar_mesa(page, context):
    executor_pronto.clear()
    page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
    fechar_popups(page)

    prazo = time.monotonic() + 15.0
    while time.monotonic() <= prazo:
        if mesa_execucao_disponivel(page):
            return True
        page.wait_for_timeout(250)

    if renovar_sessao_automaticamente(page, context):
        page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
        fechar_popups(page)
        prazo = time.monotonic() + 15.0
        while time.monotonic() <= prazo:
            if mesa_execucao_disponivel(page):
                return True
            page.wait_for_timeout(250)

    return False


def manter_interface_ativa(page):
    try:
        for frame in list(page.frames):
            btn = frame.get_by_text(re.compile(r"continuar|continue", re.IGNORECASE))
            if btn.count() > 0 and btn.first.is_visible():
                btn.first.click(force=True)
                return
    except Exception:
        pass


def iniciar_executor_playwright():
    executor_pronto.clear()

    threading.Thread(target=ouvir_ordens_redis, daemon=True).start()

    with sync_playwright() as p:
        args_camuflagem = [
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-extensions",
            "--window-size=1366,768",
        ]
        browser = p.chromium.launch(headless=True, args=args_camuflagem)

        if os.path.exists(ARQUIVO_SESSAO):
            context = browser.new_context(
                storage_state=ARQUIVO_SESSAO,
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                permissions=[],
            )
        else:
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                permissions=[],
            )

        page = context.new_page()
        aplicar_stealth(page)

        while not encerrar_executor.is_set():
            try:
                if not preparar_mesa(page, context):
                    registrar_erro_limitado(
                        "mesa_executor",
                        "⚠️ Mesa de apostas nao ficou disponivel; nova tentativa em 10s.",
                        10,
                    )
                    page.wait_for_timeout(10000)
                    continue

                executor_pronto.set()
                print("✅ Mesa carregada. Playwright liberado exclusivamente para ordens Redis.")
                ultima_verificacao_mesa = time.monotonic()

                while not encerrar_executor.is_set():
                    if page.is_closed():
                        raise RuntimeError("Pagina do executor foi fechada")

                    if not fila_apostas.empty():
                        ordem = fila_apostas.get()
                        processar_ordem_executor(page, ordem)
                    else:
                        page.wait_for_timeout(50)

                    if time.monotonic() - ultima_verificacao_mesa >= 10.0:
                        ultima_verificacao_mesa = time.monotonic()
                        manter_interface_ativa(page)
                        if not mesa_execucao_disponivel(page):
                            executor_pronto.clear()
                            print("⚠️ DOM de apostas ficou indisponivel; recarregando somente o executor.")
                            break

                executor_pronto.clear()
            except PlaywrightTimeoutError as e:
                executor_pronto.clear()
                registrar_erro_limitado("playwright_timeout", f"⚠️ Timeout do executor Playwright: {e}", 30)
                time.sleep(5)
            except Exception as e:
                executor_pronto.clear()
                registrar_erro_limitado(
                    "playwright_loop",
                    f"⚠️ Executor Playwright reiniciando navegacao: {type(e).__name__}: {e}",
                    30,
                )
                time.sleep(5)


def modo_coleta_leve():
    executor_pronto.clear()
    print("Auto Trader desativado. Modo Coleta Leve via TipMiner em andamento")
    while True:
        time.sleep(60)


if __name__ == "__main__":
    exibir_painel_versao()
    if not AUTO_TRADER_ENABLED:
        modo_coleta_leve()
    else:
        try:
            iniciar_executor_playwright()
        except KeyboardInterrupt:
            encerrar_executor.set()
            executor_pronto.clear()
            print("\n👋 Executor desligado com sucesso.")
