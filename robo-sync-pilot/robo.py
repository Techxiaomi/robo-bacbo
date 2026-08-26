from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
import threading
import queue
import time
import re
import json
import os
import socket
import ssl
from collections import OrderedDict
from urllib.parse import urlparse, unquote
from env_loader import load_env_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

# ====================================================================
# CONFIGURACAO REDIS-ONLY DO EXECUTOR
# ====================================================================
VERSAO_ROBO = "v1.6.18"
NOME_ATUALIZACAO = "Place Bet Redis + Confirmacao Financeira"

URL_CASSINO = os.getenv("CASINO_GAME_URL", "")
URL_HOME_CASSINO = os.getenv("CASINO_HOME_URL", "")
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))
USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
CASINO_BALANCE_SELECTOR = '[data-role="balance-label-value"]'
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379").strip() or "redis://127.0.0.1:6379"
REDIS_COMMAND_CHANNEL = "auto_trader_commands"
REDIS_RESPONSE_CHANNEL = "auto_trader_responses"
BROWSER_IDLE_TIMEOUT_SECONDS = 300.0
BROWSER_KEEP_ALIVE_INTERVAL_SECONDS = 15.0
DRIVER_RECOVERY_DELAY_SECONDS = 2.0
EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS = 8.0
EXECUTOR_BET_ACCEPTANCE_TOLERANCE = 0.10
BETTING_WINDOW_TIMEOUT_MS = 14000
BETTING_CHIP_SELECTOR = "[data-role='chip'][data-value]"
IDEMPOTENCY_CACHE_MAX = 100

PLAYWRIGHT_DRIVER_FATAL_MARKERS = (
    "socket.send",
    "connection closed while reading from the driver",
    "connection closed while reading from driver",
    "playwright connection closed",
    "target page, context or browser has been closed",
    "page has been closed",
    "context has been closed",
    "browser has been closed",
    "browser closed",
    "broken pipe",
    "pipe closed",
    "eof",
)


def _env_bool(nome, padrao=False):
    bruto = str(os.getenv(nome, "1" if padrao else "0") or "").strip().lower()
    return bruto in {"1", "true", "yes", "on", "sim"}


AUTO_TRADER_ENABLED = _env_bool("AUTO_TRADER_ENABLED", False)

fila_comandos_redis = queue.Queue()
auto_trader_operando = threading.Event()
navegador_aberto = threading.Event()

# Sinal cooperativo de encerramento do processo.
# O main thread recebe Ctrl+C; listener Redis e Playwright apenas observam.
encerrar_executor = threading.Event()

# O socket do SUBSCRIBE pertence ao listener Redis, mas o main pode emitir
# shutdown(SHUT_RDWR) para destravar uma leitura bloqueante durante Ctrl+C.
redis_listener_socket_lock = threading.Lock()
redis_listener_socket = None

atividade_node_lock = threading.Lock()
ultima_atividade_node_monotonic = time.monotonic()
avisos_erro_limitados = {}
ordens_idempotencia_lock = threading.Lock()
ordens_em_processamento = set()
resultados_ordens = OrderedDict()


class ErroExecucaoAposta(RuntimeError):
    def __init__(self, mensagem, ambigua=False):
        super().__init__(mensagem)
        self.execucao_ambigua = bool(ambigua)


class ErroJanelaApostasTimeout(ErroExecucaoAposta):
    pass


def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
    agora = time.time()
    ultimo = avisos_erro_limitados.get(chave, 0.0)
    if agora - ultimo >= intervalo_segundos:
        print(mensagem)
        avisos_erro_limitados[chave] = agora


def erro_driver_playwright(exc):
    texto = f"{type(exc).__name__}: {exc}".lower()
    return any(marcador in texto for marcador in PLAYWRIGHT_DRIVER_FATAL_MARKERS)


def registrar_atividade_node():
    global ultima_atividade_node_monotonic
    with atividade_node_lock:
        ultima_atividade_node_monotonic = time.monotonic()


def segundos_inatividade_node():
    with atividade_node_lock:
        ultima = float(ultima_atividade_node_monotonic)
    return max(0.0, time.monotonic() - ultima)


def auto_trader_habilitado():
    return AUTO_TRADER_ENABLED is True


def registrar_socket_listener_redis(sock):
    global redis_listener_socket

    with redis_listener_socket_lock:
        redis_listener_socket = sock


def limpar_socket_listener_redis(sock):
    global redis_listener_socket

    with redis_listener_socket_lock:
        if redis_listener_socket is sock:
            redis_listener_socket = None


def solicitar_encerramento_executor():
    """
    Sinaliza encerramento sem interromper uma operação financeira no meio.

    O shutdown do socket é proposital: socket.makefile() pode manter a leitura
    bloqueada mesmo quando o objeto socket recebe close(), enquanto SHUT_RDWR
    faz a leitura do SUBSCRIBE retornar/errar e permite ao listener executar
    seu bloco finally normalmente.
    """
    encerrar_executor.set()

    with redis_listener_socket_lock:
        sock = redis_listener_socket

    if sock is None:
        return

    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    except Exception:
        pass


# ====================================================================
# REDIS PUB/SUB SEM DEPENDENCIA EXTERNA
# ====================================================================
def _texto_redis(valor):
    if isinstance(valor, bytes):
        return valor.decode("utf-8", errors="replace")
    return str(valor)


def _configuracao_redis():
    parsed = urlparse(REDIS_URL)
    if parsed.scheme not in {"redis", "rediss"}:
        raise ValueError("REDIS_URL deve usar redis:// ou rediss://")
    caminho = (parsed.path or "").lstrip("/")
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": int(parsed.port or 6379),
        "db": int(caminho) if caminho else 0,
        "username": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "tls": parsed.scheme == "rediss",
    }


def _codificar_comando_redis(*partes):
    dados = []
    for parte in partes:
        bruto = parte if isinstance(parte, bytes) else str(parte).encode("utf-8")
        dados.append(b"$" + str(len(bruto)).encode("ascii") + b"\r\n" + bruto + b"\r\n")
    return b"*" + str(len(dados)).encode("ascii") + b"\r\n" + b"".join(dados)


def _ler_exato_redis(stream, tamanho):
    partes = []
    restante = int(tamanho)
    while restante > 0:
        bloco = stream.read(restante)
        if not bloco:
            raise ConnectionError("Conexao Redis encerrada durante leitura")
        partes.append(bloco)
        restante -= len(bloco)
    return b"".join(partes)


def _ler_resposta_redis(stream):
    prefixo = stream.read(1)
    if not prefixo:
        raise ConnectionError("Conexao Redis encerrada")
    linha = stream.readline()
    if not linha.endswith(b"\r\n"):
        raise ConnectionError("Resposta Redis truncada")
    corpo = linha[:-2]

    if prefixo == b"+":
        return corpo.decode("utf-8", errors="replace")
    if prefixo == b"-":
        raise RuntimeError(corpo.decode("utf-8", errors="replace"))
    if prefixo == b":":
        return int(corpo)
    if prefixo == b"$":
        tamanho = int(corpo)
        if tamanho < 0:
            return None
        dados = _ler_exato_redis(stream, tamanho)
        if _ler_exato_redis(stream, 2) != b"\r\n":
            raise ConnectionError("Bulk string Redis sem terminador")
        return dados
    if prefixo == b"*":
        quantidade = int(corpo)
        if quantidade < 0:
            return None
        return [_ler_resposta_redis(stream) for _ in range(quantidade)]
    raise RuntimeError(f"Tipo de resposta Redis nao suportado: {prefixo!r}")


def _enviar_comando_redis(sock, stream, *partes):
    sock.sendall(_codificar_comando_redis(*partes))
    return _ler_resposta_redis(stream)


def _abrir_conexao_redis(bloqueante=False):
    cfg = _configuracao_redis()
    sock = socket.create_connection((cfg["host"], cfg["port"]), timeout=3.0)
    if cfg["tls"]:
        contexto_tls = ssl.create_default_context()
        sock = contexto_tls.wrap_socket(sock, server_hostname=cfg["host"])
    sock.settimeout(3.0)
    stream = sock.makefile("rb")
    try:
        if cfg["password"]:
            if cfg["username"]:
                resposta = _enviar_comando_redis(sock, stream, "AUTH", cfg["username"], cfg["password"])
            else:
                resposta = _enviar_comando_redis(sock, stream, "AUTH", cfg["password"])
            if str(resposta).upper() != "OK":
                raise RuntimeError("Redis rejeitou autenticacao")
        if cfg["db"]:
            resposta = _enviar_comando_redis(sock, stream, "SELECT", cfg["db"])
            if str(resposta).upper() != "OK":
                raise RuntimeError("Redis rejeitou selecao do banco")
        if bloqueante:
            sock.settimeout(None)
        return sock, stream
    except Exception:
        try:
            stream.close()
        finally:
            sock.close()
        raise


def publicar_redis(payload):
    mensagem = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    sock = None
    stream = None
    try:
        sock, stream = _abrir_conexao_redis(bloqueante=False)
        _enviar_comando_redis(sock, stream, "PUBLISH", REDIS_RESPONSE_CHANNEL, mensagem)
        return True
    finally:
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def publicar_saldo_redis(saldo):
    return publicar_redis({
        "action": "balance_update",
        "balance": round(float(saldo), 2),
    })


def montar_resultado_aposta(order_id, status, motivo="", confirmacao=None):
    payload = {
        "action": "bet_result",
        "order_id": str(order_id or "").strip().lower(),
        "status": str(status or "").strip().upper(),
        "motivo": str(motivo or "")[:300],
    }
    if confirmacao is not None:
        payload["confirmacao"] = confirmacao
    return payload


def publicar_resultado_aposta_redis(order_id, status, motivo="", confirmacao=None):
    return publicar_redis(
        montar_resultado_aposta(order_id, status, motivo, confirmacao)
    )


def consultar_order_id(order_id):
    order_id = str(order_id or "").strip().lower()
    with ordens_idempotencia_lock:
        resultado = resultados_ordens.get(order_id)
        if resultado is not None:
            resultados_ordens.move_to_end(order_id)
            return "FINALIZADA", dict(resultado)
        if order_id in ordens_em_processamento:
            return "EM_PROCESSAMENTO", None
        return "NOVA", None


def reservar_order_id(order_id):
    order_id = str(order_id or "").strip().lower()
    with ordens_idempotencia_lock:
        resultado = resultados_ordens.get(order_id)
        if resultado is not None:
            resultados_ordens.move_to_end(order_id)
            return "FINALIZADA", dict(resultado)
        if order_id in ordens_em_processamento:
            return "EM_PROCESSAMENTO", None
        ordens_em_processamento.add(order_id)
        return "NOVA", None


def cachear_resultado_order_id(order_id, payload):
    order_id = str(order_id or "").strip().lower()
    resultado = dict(payload or {})
    with ordens_idempotencia_lock:
        ordens_em_processamento.discard(order_id)
        resultados_ordens[order_id] = resultado
        resultados_ordens.move_to_end(order_id)
        while len(resultados_ordens) > IDEMPOTENCY_CACHE_MAX:
            resultados_ordens.popitem(last=False)
    return dict(resultado)


def republicar_resultado_order_id(order_id, payload):
    try:
        publicar_redis(payload)
        return True
    except Exception as erro_redis:
        registrar_erro_limitado(
            f"redis_replay_{order_id}",
            f"⚠️ Falha ao republicar resultado idempotente de {order_id}: {type(erro_redis).__name__}: {erro_redis}",
            10,
        )
        return False


def finalizar_order_id(order_id, status, motivo="", confirmacao=None):
    payload = montar_resultado_aposta(order_id, status, motivo, confirmacao)

    # O terminal financeiro e memorizado ANTES do publish. Se o Redis falhar depois
    # do clique/debito, um retry com o mesmo order_id jamais executa fisicamente de novo.
    cachear_resultado_order_id(order_id, payload)

    try:
        publicar_redis(payload)
    except Exception as erro_redis:
        registrar_erro_limitado(
            f"redis_bet_result_{order_id}",
            f"⚠️ Resultado {payload['status']} de {order_id} cacheado, mas publish Redis falhou: "
            f"{type(erro_redis).__name__}: {erro_redis}",
            10,
        )
    return payload


def ouvir_comandos_redis():
    while not encerrar_executor.is_set():
        sock = None
        stream = None

        try:
            sock, stream = _abrir_conexao_redis(
                bloqueante=True
            )

            registrar_socket_listener_redis(
                sock
            )

            confirmacao = _enviar_comando_redis(
                sock,
                stream,
                "SUBSCRIBE",
                REDIS_COMMAND_CHANNEL,
            )

            if (
                not isinstance(
                    confirmacao,
                    list
                )
                or len(confirmacao) < 3
                or _texto_redis(
                    confirmacao[0]
                ).lower() != "subscribe"
            ):
                raise RuntimeError(
                    "Redis nao confirmou assinatura de "
                    "auto_trader_commands"
                )

            print(
                f"🎧 Redis ativo: aguardando comandos em "
                f"{REDIS_COMMAND_CHANNEL}."
            )

            while not encerrar_executor.is_set():
                resposta = _ler_resposta_redis(
                    stream
                )

                if encerrar_executor.is_set():
                    break

                if (
                    not isinstance(
                        resposta,
                        list
                    )
                    or len(resposta) < 3
                ):
                    continue

                if (
                    _texto_redis(
                        resposta[0]
                    ).lower()
                    != "message"
                ):
                    continue

                if (
                    _texto_redis(
                        resposta[1]
                    )
                    != REDIS_COMMAND_CHANNEL
                ):
                    continue

                try:
                    dados = json.loads(
                        _texto_redis(
                            resposta[2]
                        )
                    )
                except json.JSONDecodeError:
                    continue

                if not isinstance(
                    dados,
                    dict
                ):
                    continue

                registrar_atividade_node()

                acao = str(
                    dados.get(
                        "action"
                    )
                    or ""
                ).strip()

                if acao == "sync_balance":
                    fila_comandos_redis.put(
                        dados
                    )
                    continue

                if acao != "place_bet":
                    continue

                order_id = str(
                    dados.get(
                        "order_id"
                    )
                    or ""
                ).strip().lower()

                if not order_id:
                    print(
                        "⚠️ place_bet rejeitado no listener: "
                        "order_id ausente."
                    )
                    continue

                estado_id, resultado_anterior = (
                    consultar_order_id(
                        order_id
                    )
                )

                if estado_id == "FINALIZADA":
                    print(
                        f"🛡️ IDEMPOTÊNCIA | duplicata bloqueada "
                        f"no listener | order_id={order_id} | "
                        f"status={resultado_anterior.get('status')}"
                    )

                    republicar_resultado_order_id(
                        order_id,
                        resultado_anterior,
                    )
                    continue

                if estado_id == "EM_PROCESSAMENTO":
                    print(
                        f"🛡️ IDEMPOTÊNCIA | duplicata ainda em "
                        f"processamento bloqueada | "
                        f"order_id={order_id}"
                    )
                    continue

                if not auto_trader_habilitado():
                    finalizar_order_id(
                        order_id,
                        "FALHOU",
                        motivo="AUTO_TRADER_DESLIGADO",
                    )

                    print(
                        f"🛑 AUTO TRADER | ordem rejeitada pelo "
                        f"fusível | order_id={order_id}"
                    )
                    continue

                # Após pedido de shutdown nenhuma tarefa nova entra no worker.
                if encerrar_executor.is_set():
                    break

                fila_comandos_redis.put(
                    dados
                )

        except Exception as e:
            if encerrar_executor.is_set():
                break

            registrar_erro_limitado(
                "redis_auto_trader_commands",
                (
                    "⚠️ Redis auto_trader_commands indisponivel: "
                    f"{type(e).__name__}: {e}"
                ),
                30,
            )

            # Diferente de time.sleep(2), o Event permite que Ctrl+C
            # interrompa também o backoff de reconexão imediatamente.
            if encerrar_executor.wait(
                2.0
            ):
                break

        finally:
            limpar_socket_listener_redis(
                sock
            )

            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
def aplicar_stealth(page):
    try:
        from playwright_stealth import stealth_sync
        stealth_sync(page)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page.add_init_script("window.navigator.chrome = { runtime: {} };")


def fechar_popups(page):
    try:
        btn_cookie = page.locator("button", has_text=re.compile(r"Aceitar todos", re.IGNORECASE))
        for i in range(min(btn_cookie.count(), 8)):
            if btn_cookie.nth(i).is_visible():
                btn_cookie.nth(i).click(force=True)
                page.wait_for_timeout(500)
                break
    except Exception as e:
        if erro_driver_playwright(e):
            raise
    try:
        btn_sim = page.locator("button", has_text=re.compile(r"^Sim$", re.IGNORECASE))
        if btn_sim.count() == 0:
            btn_sim = page.locator("button", has_text=re.compile(r"Sim", re.IGNORECASE))
        for i in range(min(btn_sim.count(), 8)):
            if btn_sim.nth(i).is_visible():
                btn_sim.nth(i).click(force=True)
                page.wait_for_timeout(500)
                break
    except Exception as e:
        if erro_driver_playwright(e):
            raise


def fechar_popup_inatividade(page):
    padrao = re.compile(
        r"^(continuar|continue|retomar|resume|voltar ao jogo|back to game|reconectar|reconnect)$",
        re.IGNORECASE,
    )
    try:
        contextos = [page] + list(page.frames)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False

    for contexto in contextos:
        try:
            candidatos = contexto.get_by_text(padrao)
            for indice in range(min(candidatos.count(), 12)):
                elemento = candidatos.nth(indice)
                if elemento.is_visible():
                    elemento.click(force=True, timeout=1500)
                    page.wait_for_timeout(500)
                    return True
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            continue
    return False


def pagina_indica_conexao_caida(page):
    padrao = re.compile(
        r"conex[aã]o perdida|connection lost|reconectando|reconnecting|erro de conex[aã]o|connection error|network error|tente novamente|try again",
        re.IGNORECASE,
    )
    try:
        contextos = [page] + list(page.frames)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False

    for contexto in contextos:
        try:
            candidatos = contexto.get_by_text(padrao)
            for indice in range(min(candidatos.count(), 8)):
                if candidatos.nth(indice).is_visible():
                    return True
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            continue
    return False


def renovar_sessao_automaticamente(page, context):
    if not URL_HOME_CASSINO:
        return False
    try:
        page.goto(URL_HOME_CASSINO, wait_until="domcontentloaded", timeout=60000)
        fechar_popups(page)

        botoes_entrar = page.locator("button", has_text=re.compile(r"Entrar", re.IGNORECASE))
        login_aberto = False
        for i in range(min(botoes_entrar.count(), 8)):
            btn = botoes_entrar.nth(i)
            if not btn.is_visible():
                continue
            try:
                btn.click(force=True)
                page.wait_for_timeout(2500)
                email = page.locator("input[name='email']")
                if email.count() > 0 and email.first.is_visible():
                    login_aberto = True
                    break
            except Exception as e:
                if erro_driver_playwright(e):
                    raise
                continue

        if not login_aberto:
            email = page.locator("input[name='email']")
            login_aberto = email.count() > 0 and email.first.is_visible()
        if not login_aberto:
            return False

        page.locator("input[name='email']").fill(USUARIO_CASSINO)
        page.wait_for_timeout(500)
        page.locator("input[name='password']").fill(SENHA_CASSINO)
        page.wait_for_timeout(500)

        botao_confirmar = page.locator("button#legitimuz-action-send-analisys")
        if botao_confirmar.count() > 0 and botao_confirmar.first.is_visible():
            botao_confirmar.first.click(force=True)
        else:
            page.locator("input[name='password']").press("Enter")

        page.wait_for_timeout(6000)
        context.storage_state(path=ARQUIVO_SESSAO)
        return True
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        registrar_erro_limitado(
            "auto_login",
            f"⚠️ Auto-Login falhou: {type(e).__name__}: {e}",
            30,
        )
        return False


def parsear_valor_monetario(texto):
    if texto is None:
        return None

    limpo = re.sub(r"[^\d,]", "", str(texto).replace("\xa0", ""))
    if not limpo:
        return None

    if "," in limpo:
        inteiro, decimal = limpo.rsplit(",", 1)
        if not inteiro:
            inteiro = "0"
        bruto = inteiro + ("." + decimal if decimal else "")
    else:
        bruto = limpo

    try:
        valor = float(bruto)
    except ValueError:
        return None
    if valor < 0:
        return None
    return round(valor, 2)


def pagina_na_rota_home(page):
    if not URL_HOME_CASSINO:
        return False
    try:
        return _rota_url(page.url) == _rota_url(URL_HOME_CASSINO)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False


def _ler_saldo_contexto(contexto):
    try:
        localizador = contexto.locator(CASINO_BALANCE_SELECTOR)
        for indice in range(min(localizador.count(), 10)):
            elemento = localizador.nth(indice)
            if not elemento.is_visible():
                continue

            texto = elemento.get_attribute("data-balance-visible")
            if not texto:
                texto = elemento.inner_text(timeout=700)

            saldo = parsear_valor_monetario(texto)
            if saldo is not None:
                return saldo

    except Exception as e:
        if erro_driver_playwright(e):
            raise

    return None


def localizar_frame_saldo_mesa(page):
    """
    INVARIANTE FINANCEIRA:
    se a URL da mesa estiver aberta, saldo do main frame/topo
    jamais pode participar da operacao.

    Apenas subframes da mesa Evolution sao candidatos.
    """
    if not pagina_na_rota_da_mesa(page):
        return None

    try:
        frame_principal = page.main_frame
        frames = list(page.frames)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None

    frames_com_saldo = []
    frames_evolution_com_saldo = []

    for frame in frames:
        if frame == frame_principal:
            continue

        try:
            if frame.locator(CASINO_BALANCE_SELECTOR).count() <= 0:
                continue
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            continue

        frames_com_saldo.append(frame)

        try:
            if _frame_evolution_pronto(frame):
                return frame
        except Exception as e:
            if erro_driver_playwright(e):
                raise

        try:
            url = str(frame.url or "").lower()
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            url = ""

        if any(
            marca in url
            for marca in (
                "evolution",
                "evocdn",
                "game"
            )
        ):
            frames_evolution_com_saldo.append(frame)

    # Um único frame claramente Evolution com saldo é seguro.
    if len(frames_evolution_com_saldo) == 1:
        return frames_evolution_com_saldo[0]

    # Compatibilidade com iframe opaco:
    # somente aceitamos quando existe UM ÚNICO subframe com saldo.
    # Nunca usamos o main frame nesta rota.
    if len(frames_com_saldo) == 1:
        return frames_com_saldo[0]

    # Ambiguidade financeira => fail-closed.
    return None


def localizar_frame_mesa(page):
    """
    Descobre o frame operacional da mesa independentemente
    do seletor de saldo.
    """
    if not pagina_na_rota_da_mesa(page):
        return None

    try:
        frame_principal = page.main_frame
        frames = [
            frame
            for frame in list(page.frames)
            if frame != frame_principal
        ]
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None

    # Evidência mais forte: fichas da janela de apostas.
    for frame in frames:
        try:
            if frame.locator(BETTING_CHIP_SELECTOR).count() > 0:
                return frame
        except Exception as e:
            if erro_driver_playwright(e):
                raise

    # Segunda evidência: superfícies Bac Bo.
    for frame in frames:
        try:
            if frame.locator("[data-role^='bacbo-bet-spot-']").count() > 0:
                return frame
        except Exception as e:
            if erro_driver_playwright(e):
                raise

    # Último reconhecimento: contrato Evolution já existente.
    for frame in frames:
        try:
            if _frame_evolution_pronto(frame):
                return frame
        except Exception as e:
            if erro_driver_playwright(e):
                raise

    return None


def aguardar_janela_apostas_aberta(page):
    frame = localizar_frame_mesa(page)
    if frame is None:
        raise ErroExecucaoAposta(
            "Frame da mesa indisponivel antes do gate de apostas",
            ambigua=False,
        )

    try:
        frame.wait_for_selector(
            BETTING_CHIP_SELECTOR,
            state="visible",
            timeout=BETTING_WINDOW_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError as e:
        raise ErroJanelaApostasTimeout(
            f"JANELA_FECHADA_TIMEOUT: nenhuma ficha ficou visivel em {BETTING_WINDOW_TIMEOUT_MS}ms"
        ) from e

    return frame


def _texto_saldo_home_valido(texto):
    """
    Contrato estrito do saldo superior da HOME.

    O DOM atual da casa expõe:
      button[type="button"]
        > span.inline-flex.items-center.gap-2
            R$ 1.580,00

    Esta validação NÃO é usada dentro da Evolution.
    """
    if texto is None:
        return None

    normalizado = (
        str(texto)
        .replace("\xa0", " ")
        .strip()
    )

    if not re.fullmatch(
        r"R\$\s*(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}",
        normalizado,
    ):
        return None

    return parsear_valor_monetario(
        normalizado
    )


def _ler_saldo_home_principal(page):
    """
    Lê exclusivamente o saldo superior do documento principal.

    Segurança:
    - somente elementos visíveis;
    - somente dentro de button[type=button];
    - texto monetário BR estrito;
    - exatamente UM candidato válido.

    Zero ou múltiplos candidatos => fail-closed.
    """
    seletor = (
        "button[type='button'] "
        "> span.inline-flex.items-center.gap-2"
    )

    saldos_validos = []

    try:
        candidatos = page.locator(
            seletor
        )

        quantidade = min(
            candidatos.count(),
            64,
        )

        for indice in range(
            quantidade
        ):
            elemento = candidatos.nth(
                indice
            )

            if not elemento.is_visible():
                continue

            try:
                texto = elemento.inner_text(
                    timeout=700
                )
            except Exception as e:
                if erro_driver_playwright(e):
                    raise
                continue

            saldo = _texto_saldo_home_valido(
                texto
            )

            if saldo is not None:
                saldos_validos.append(
                    saldo
                )

    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None

    if len(saldos_validos) != 1:
        return None

    return saldos_validos[0]


def ler_saldo_home(page, aguardar_ms=0):
    """
    Saldo do topo permitido SOMENTE na URL HOME.

    Nunca percorre frames.
    Nunca é fallback quando a mesa está aberta.
    """
    if not pagina_na_rota_home(page):
        return None

    prazo = (
        time.monotonic()
        + max(
            0.0,
            float(aguardar_ms) / 1000.0
        )
    )

    while True:
        saldo = _ler_saldo_home_principal(
            page
        )

        if saldo is not None:
            return saldo

        if time.monotonic() >= prazo:
            return None

        page.wait_for_timeout(250)

def ler_saldo_mesa(page, aguardar_ms=0):
    """
    Na rota da mesa, lê EXCLUSIVAMENTE o saldo existente
    dentro do subframe Evolution.

    Não existe fallback para o saldo superior do cassino.
    """
    if not pagina_na_rota_da_mesa(page):
        return None

    prazo = (
        time.monotonic()
        + max(
            0.0,
            float(aguardar_ms) / 1000.0
        )
    )

    while True:
        frame = localizar_frame_saldo_mesa(page)

        if frame is not None:
            saldo = _ler_saldo_contexto(frame)

            if saldo is not None:
                return saldo

        if time.monotonic() >= prazo:
            return None

        page.wait_for_timeout(250)


def ler_saldo_atual(page, aguardar_ms=0):
    """
    Dispatcher financeiro fail-closed.

    HOME  -> main frame/topo.
    MESA  -> subframe Evolution.
    OUTRO -> nenhum saldo é aceito.
    """
    if pagina_na_rota_da_mesa(page):
        return ler_saldo_mesa(
            page,
            aguardar_ms=aguardar_ms
        )

    if pagina_na_rota_home(page):
        return ler_saldo_home(
            page,
            aguardar_ms=aguardar_ms
        )

    return None

def primeiro_elemento_dom_visivel(locator, limite=32):
    try:
        quantidade = min(max(0, int(locator.count())), max(1, int(limite)))
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None
    for indice in range(quantidade):
        try:
            elemento = locator.nth(indice)
            if elemento.is_visible():
                return elemento
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            continue
    return None


def _frame_evolution_pronto(frame):
    try:
        url = str(frame.url or "").lower()
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        url = ""

    try:
        if frame.locator("[data-role='chip'][data-value]").count() > 0:
            return True
    except Exception as e:
        if erro_driver_playwright(e):
            raise

    try:
        if frame.locator("[data-role^='bacbo-bet-spot-']").count() > 0:
            return True
    except Exception as e:
        if erro_driver_playwright(e):
            raise

    if any(marca in url for marca in ("evolution", "evocdn", "game")):
        try:
            if frame.locator("canvas").count() > 0:
                return True
        except Exception as e:
            if erro_driver_playwright(e):
                raise
    return False


def mesa_evolution_pronta(page):
    try:
        frames = list(page.frames)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False

    for frame in frames:
        if _frame_evolution_pronto(frame):
            return True

    try:
        if page.locator("iframe[src*='evolution' i], iframe[src*='evocdn' i], iframe[src*='game' i]").count() > 0:
            return True
    except Exception as e:
        if erro_driver_playwright(e):
            raise
    return False


def aguardar_mesa_evolution(page, timeout_ms=30000):
    prazo = time.monotonic() + max(1.0, float(timeout_ms) / 1000.0)
    while time.monotonic() < prazo:
        if mesa_evolution_pronta(page):
            return True
        page.wait_for_timeout(500)
    return mesa_evolution_pronta(page)


def _rota_url(url):
    try:
        parsed = urlparse(str(url or ""))
        return (
            (parsed.scheme or "").lower(),
            (parsed.netloc or "").lower(),
            (parsed.path or "/").rstrip("/") or "/",
        )
    except Exception:
        return ("", "", "")


def pagina_na_rota_da_mesa(page):
    if not URL_CASSINO:
        return False
    try:
        return _rota_url(page.url) == _rota_url(URL_CASSINO)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False


def localizar_ficha(frame, valor_ficha):
    candidatos = frame.locator("[data-role='chip'][data-value]")
    try:
        quantidade = min(max(0, int(candidatos.count())), 64)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None

    for indice in range(quantidade):
        candidato = candidatos.nth(indice)
        try:
            valor_bruto = candidato.get_attribute("data-value") or ""
            valor = float(str(valor_bruto).strip().replace(" ", "").replace(",", "."))
            if abs(valor - float(valor_ficha)) >= 0.001 or not candidato.is_visible():
                continue
            return candidato
        except Exception as e:
            if erro_driver_playwright(e):
                raise
            continue
    return None


def localizar_frame_aposta(page, planos):
    try:
        frames = list(page.frames)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return None

    for frame in frames:
        completo = True
        for plano in planos:
            if primeiro_elemento_dom_visivel(frame.locator(f"[data-role='{plano['seletor_alvo']}']")) is None:
                completo = False
                break
            for ficha, _ in plano["cliques_necessarios"]:
                if localizar_ficha(frame, ficha) is None:
                    completo = False
                    break
            if not completo:
                break
        if completo:
            return frame
    return None


def resolver_ponto_seguro_alvo(elemento):
    try:
        return elemento.evaluate(
            """el => {
                const r = el.getBoundingClientRect();
                if (!r || r.width <= 2 || r.height <= 2) return {ok:false};
                const pontos = [[0.50,0.50],[0.50,0.35],[0.50,0.65],[0.35,0.50],[0.65,0.50]];
                for (const [fx, fy] of pontos) {
                    const hit = document.elementFromPoint(r.left + r.width*fx, r.top + r.height*fy);
                    if (hit && (hit === el || el.contains(hit))) {
                        return {ok:true, x:r.width*fx, y:r.height*fy};
                    }
                }
                return {ok:false};
            }"""
        )
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return {"ok": False}


def clicar_alvo_financeiro(elemento):
    ponto = resolver_ponto_seguro_alvo(elemento)
    if not isinstance(ponto, dict) or ponto.get("ok") is not True:
        return False
    elemento.click(
        position={"x": float(ponto["x"]), "y": float(ponto["y"])},
        timeout=1200,
    )
    return True


def normalizar_apostas_recebidas(dados):
    bruto = dados.get("apostas") if isinstance(dados, dict) else None
    if bruto is None and isinstance(dados, dict):
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


def montar_planos_aposta(dados):
    mapa_alvos = {
        "PlayerWon": "bacbo-bet-spot-Player",
        "BankerWon": "bacbo-bet-spot-Banker",
        "Tie": "bacbo-bet-spot-Tie",
    }
    fichas_disponiveis = [5000, 2500, 500, 125, 25, 10, 5]
    planos = []
    for perna in normalizar_apostas_recebidas(dados):
        valor_total = int(perna["valor"])
        restante = valor_total
        cliques = []
        for ficha in fichas_disponiveis:
            qtd = restante // ficha
            if qtd > 0:
                cliques.append((ficha, qtd))
                restante %= ficha
        if restante != 0 or not cliques:
            raise ValueError(f"Valor R$ {valor_total} nao representavel pelas fichas disponiveis")
        planos.append({
            "alvo": perna["alvo"],
            "valor": valor_total,
            "seletor_alvo": mapa_alvos[perna["alvo"]],
            "cliques_necessarios": cliques,
        })
    return planos


def confirmar_debito_saldo(page, saldo_antes, exposicao):
    if saldo_antes is None:
        return False, None
    page.wait_for_timeout(2500)
    prazo = time.monotonic() + EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS
    ultimo_saldo = None
    while time.monotonic() <= prazo:
        ultimo_saldo = ler_saldo_atual(page)
        if ultimo_saldo is not None:
            debito = round(float(saldo_antes) - float(ultimo_saldo), 2)
            if abs(debito - float(exposicao)) <= EXECUTOR_BET_ACCEPTANCE_TOLERANCE:
                return True, ultimo_saldo
        page.wait_for_timeout(150)
    return False, ultimo_saldo


def executar_place_bet(page, dados):
    planos = montar_planos_aposta(dados)

    # Gate financeiro real: a ordem pode chegar antes da janela, mas nenhum clique
    # ocorre enquanto a Evolution nao expuser uma ficha de aposta visivel no DOM.
    frame = aguardar_janela_apostas_aberta(page)

    # O saldo-base e lido somente apos a abertura da janela, imediatamente antes
    # da validacao dos controles e dos cliques financeiros.
    saldo_antes = ler_saldo_atual(page, aguardar_ms=2500)
    if saldo_antes is None:
        raise ErroExecucaoAposta("Saldo real indisponivel antes da aposta", ambigua=False)

    ficha_corrente = None
    cliques_alvo = 0
    try:
        for plano in planos:
            alvo = primeiro_elemento_dom_visivel(frame.locator(f"[data-role='{plano['seletor_alvo']}']"))
            if alvo is None:
                raise RuntimeError(f"Alvo {plano['alvo']} indisponivel")

            for ficha, qtd in plano["cliques_necessarios"]:
                ficha_elemento = localizar_ficha(frame, ficha)
                if ficha_elemento is None:
                    raise RuntimeError(f"Ficha R$ {ficha} indisponivel")
                if ficha_corrente != int(ficha):
                    ficha_elemento.click(force=True, timeout=2000)
                    page.wait_for_timeout(120)
                    ficha_corrente = int(ficha)

                for _ in range(int(qtd)):
                    if not clicar_alvo_financeiro(alvo):
                        raise RuntimeError(f"Clique financeiro em {plano['alvo']} nao autorizado pelo hit-test")
                    cliques_alvo += 1
                    page.wait_for_timeout(120)

        exposicao = float(sum(plano["valor"] for plano in planos))
        confirmado, saldo_depois = confirmar_debito_saldo(page, saldo_antes, exposicao)
        if not confirmado:
            raise ErroExecucaoAposta(
                f"Debito financeiro nao confirmado; saldo_antes={saldo_antes}, saldo_depois={saldo_depois}, exposicao={exposicao}",
                ambigua=True,
            )

        debito_observado = round(float(saldo_antes) - float(saldo_depois), 2)
        confirmada_em = int(time.time() * 1000)
        confirmacao = {
            "confirmada": True,
            "metodo": "SALDO_DEBITADO",
            "saldo_antes": round(float(saldo_antes), 2),
            "saldo_depois": round(float(saldo_depois), 2),
            "exposicao_esperada": round(float(exposicao), 2),
            "debito_observado": debito_observado,
            "confirmada_em": confirmada_em,
        }

        print(
            f"✅ Ordem Redis executada: {cliques_alvo} clique(s) financeiro(s); "
            f"saldo R$ {float(saldo_antes):.2f} -> R$ {float(saldo_depois):.2f}."
        )
        return confirmacao
    except ErroExecucaoAposta:
        raise
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        raise ErroExecucaoAposta(str(e), ambigua=(cliques_alvo > 0)) from e


def garantir_mesa_pronta(page, context):
    if pagina_na_rota_da_mesa(page) and mesa_evolution_pronta(page):
        return True

    if not URL_CASSINO:
        return False

    page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
    fechar_popups(page)
    if aguardar_mesa_evolution(page, 30000):
        return True

    if not renovar_sessao_automaticamente(page, context):
        return False

    # O login acontece no lobby, mas o destino final e sempre a mesa.
    page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
    fechar_popups(page)
    return aguardar_mesa_evolution(page, 30000)


def garantir_destino_final_mesa(page, context):
    if garantir_mesa_pronta(page, context):
        return True
    raise RuntimeError("Nao foi possivel manter a Evolution como destino final da navegacao")


def manter_mesa_viva(page, context):
    if page is None:
        return False
    try:
        if page.is_closed():
            return False

        fechar_popups(page)
        fechar_popup_inatividade(page)

        conexao_caida = pagina_indica_conexao_caida(page)
        mesa_presente = pagina_na_rota_da_mesa(page) and mesa_evolution_pronta(page)
        if mesa_presente and not conexao_caida:
            return True

        registrar_erro_limitado(
            "keep_alive_reload",
            "🔄 Mesa fora da rota/sem interface Evolution saudavel; restaurando URL da mesa sem monitorar resultados.",
            15,
        )
        try:
            if pagina_na_rota_da_mesa(page):
                page.reload(wait_until="domcontentloaded", timeout=60000)
            else:
                page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
            fechar_popups(page)
            if aguardar_mesa_evolution(page, 20000):
                return True
        except Exception as e:
            if erro_driver_playwright(e):
                raise

        return garantir_mesa_pronta(page, context)
    except Exception as e:
        if erro_driver_playwright(e):
            raise
        return False


def abrir_navegador(p):
    args_camuflagem = [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--window-size=1366,768",
    ]
    browser = p.chromium.launch(headless=True, args=args_camuflagem)
    kwargs_contexto = {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "permissions": [],
    }
    if os.path.exists(ARQUIVO_SESSAO):
        kwargs_contexto["storage_state"] = ARQUIVO_SESSAO
    context = browser.new_context(**kwargs_contexto)
    page = context.new_page()
    aplicar_stealth(page)
    navegador_aberto.set()
    return browser, context, page


def fechar_navegador(sessao, corrompido=False):
    context = sessao.get("context")
    browser = sessao.get("browser")
    sessao.update({"browser": None, "context": None, "page": None, "ultima_manutencao": 0.0})
    navegador_aberto.clear()

    if corrompido:
        try:
            if browser is not None and browser.is_connected():
                browser.close()
        except Exception:
            pass
        return

    try:
        if context is not None:
            context.close()
    except Exception:
        pass
    try:
        if browser is not None:
            browser.close()
    except Exception:
        pass


def garantir_navegador(p, sessao):
    page = sessao.get("page")
    if page is not None:
        try:
            if not page.is_closed():
                return page, sessao.get("context")
        except Exception as e:
            if erro_driver_playwright(e):
                raise
        fechar_navegador(sessao)

    browser, context, page = abrir_navegador(p)
    sessao.update({"browser": browser, "context": context, "page": page, "ultima_manutencao": 0.0})
    return page, context


def processar_comando_playwright(p, sessao, comando):
    acao = str(comando.get("action") or "").strip()

    if acao == "place_bet":
        order_id = str(comando.get("order_id") or "").strip().lower()
        if not order_id:
            raise ValueError("place_bet recebido sem order_id")

        # Defesa em profundidade: antes de qualquer browser/frame/saldo, o worker
        # confirma idempotencia e o fusivel, mesmo que a fila seja alimentada por outro caminho no futuro.
        estado_id, resultado_anterior = reservar_order_id(order_id)
        if estado_id == "FINALIZADA":
            print(
                f"🛡️ IDEMPOTÊNCIA | ordem duplicada bloqueada no worker | "
                f"order_id={order_id} | status_original={resultado_anterior.get('status')}"
            )
            republicar_resultado_order_id(order_id, resultado_anterior)
            return

        if estado_id == "EM_PROCESSAMENTO":
            print(
                f"🛡️ IDEMPOTÊNCIA | ordem duplicada em processamento bloqueada no worker | order_id={order_id}"
            )
            return

        if not auto_trader_habilitado():
            finalizar_order_id(
                order_id,
                "FALHOU",
                motivo="AUTO_TRADER_DESLIGADO",
            )
            print(
                f"🛑 AUTO TRADER | ordem rejeitada pelo fusível no worker | order_id={order_id}"
            )
            return

        auto_trader_operando.set()
        try:
            page, context = garantir_navegador(p, sessao)
            garantir_destino_final_mesa(page, context)

            confirmacao = executar_place_bet(page, comando)
            garantir_destino_final_mesa(page, context)
            finalizar_order_id(
                order_id,
                "EXECUTADA",
                confirmacao=confirmacao,
            )
            return
        except ErroJanelaApostasTimeout as e:
            finalizar_order_id(
                order_id,
                "EXPIRADA",
                motivo=str(e),
            )
            print(
                f"⏱️ Ordem {order_id}: janela de apostas nao abriu em "
                f"{BETTING_WINDOW_TIMEOUT_MS}ms; entrada descartada."
            )
            return
        except Exception as e:
            status = "AMBIGUA" if (
                erro_driver_playwright(e)
                or getattr(e, "execucao_ambigua", False) is True
            ) else "FALHOU"
            finalizar_order_id(order_id, status, motivo=str(e))
            raise
        finally:
            auto_trader_operando.clear()

    if acao == "sync_balance":
        page, context = garantir_navegador(p, sessao)

        # ============================================================
        # INVARIANTE DE SALDO
        #
        # 1) Se JA estamos na mesa:
        #    saldo SOMENTE do frame Evolution.
        #
        # 2) Se o navegador acabou de abrir / estamos fora da mesa:
        #    tenta HOME primeiro e saldo SOMENTE do main frame.
        #
        # 3) Depois que a mesa for aberta:
        #    o saldo superior fica proibido como fallback.
        # ============================================================

        if pagina_na_rota_da_mesa(page):
            saldo = ler_saldo_mesa(
                page,
                aguardar_ms=5000
            )

            if saldo is None:
                raise RuntimeError(
                    "SALDO_MESA_INDISPONIVEL: "
                    "saldo real nao localizado no frame da mesa Evolution"
                )

            publicar_saldo_redis(saldo)

            print(
                f"💰 Saldo real publicado via Redis: "
                f"R$ {saldo:.2f} | origem=MESA_EVOLUTION."
            )

            garantir_destino_final_mesa(
                page,
                context
            )
            return

        # Navegador novo, lobby ou contexto ainda fora da mesa.
        # O saldo superior somente pode ser lido na URL HOME.
        saldo = None

        if URL_HOME_CASSINO:
            try:
                if not pagina_na_rota_home(page):
                    page.goto(
                        URL_HOME_CASSINO,
                        wait_until="domcontentloaded",
                        timeout=60000,
                    )
                    fechar_popups(page)

                saldo = ler_saldo_home(
                    page,
                    aguardar_ms=2500
                )

                # Se a sessão persistida expirou, renova o login
                # e tenta NOVAMENTE no HOME antes de abrir a mesa.
                if saldo is None:
                    renovar_sessao_automaticamente(
                        page,
                        context
                    )

                    saldo = ler_saldo_home(
                        page,
                        aguardar_ms=5000
                    )

            except Exception as e:
                if erro_driver_playwright(e):
                    raise

                registrar_erro_limitado(
                    "sync_balance_home",
                    (
                        "⚠️ Saldo HOME indisponivel; "
                        "tentando contexto da mesa sem usar "
                        f"o topo como fallback: {type(e).__name__}: {e}"
                    ),
                    15,
                )

        if saldo is not None:
            publicar_saldo_redis(saldo)

            print(
                f"💰 Saldo real publicado via Redis: "
                f"R$ {saldo:.2f} | origem=HOME."
            )

            # Depois da leitura válida do HOME, o destino operacional
            # continua sendo a mesa. A partir daqui o topo passa a ser stale.
            garantir_destino_final_mesa(
                page,
                context
            )
            return

        # HOME não forneceu um saldo real.
        # Podemos TRANSICIONAR para a mesa, mas depois da transição
        # a leitura é EXCLUSIVAMENTE no frame Evolution.
        garantir_destino_final_mesa(
            page,
            context
        )

        saldo = ler_saldo_mesa(
            page,
            aguardar_ms=5000
        )

        if saldo is None:
            raise RuntimeError(
                "SALDO_MESA_INDISPONIVEL_APOS_HOME: "
                "saldo do topo nao foi aceito e saldo real "
                "nao foi localizado no frame da mesa Evolution"
            )

        publicar_saldo_redis(saldo)

        print(
            f"💰 Saldo real publicado via Redis: "
            f"R$ {saldo:.2f} | origem=MESA_EVOLUTION_APOS_HOME."
        )

        garantir_destino_final_mesa(
            page,
            context
        )
        return


def executar_manutencao_se_devida(p, sessao, forcar_abertura=False):
    agora = time.monotonic()
    page = sessao.get("page")

    if page is None and not forcar_abertura:
        return

    if page is None:
        page, context = garantir_navegador(p, sessao)
        garantir_destino_final_mesa(page, context)
        sessao["ultima_manutencao"] = agora
        return

    if agora - float(sessao.get("ultima_manutencao") or 0.0) < BROWSER_KEEP_ALIVE_INTERVAL_SECONDS:
        return

    context = sessao.get("context")
    if not manter_mesa_viva(page, context):
        raise RuntimeError("Keep-alive nao conseguiu restaurar a mesa")
    sessao["ultima_manutencao"] = agora


def ciclo_playwright(p, sessao):
    while not encerrar_executor.is_set():
        try:
            comando = fila_comandos_redis.get(timeout=1.0)
        except queue.Empty:
            if encerrar_executor.is_set():
                return
            try:
                if auto_trader_habilitado():
                    executar_manutencao_se_devida(p, sessao, forcar_abertura=True)
                    continue

                if (
                    navegador_aberto.is_set()
                    and not auto_trader_operando.is_set()
                    and fila_comandos_redis.empty()
                    and segundos_inatividade_node() >= BROWSER_IDLE_TIMEOUT_SECONDS
                ):
                    print("🛌 Auto Trader desligado e 5 minutos apos a ultima tarefa/comando: fechando navegador e mantendo Redis ativo.")
                    fechar_navegador(sessao)
                    continue

                if navegador_aberto.is_set():
                    executar_manutencao_se_devida(p, sessao, forcar_abertura=False)
            except Exception as e:
                if erro_driver_playwright(e):
                    registrar_erro_limitado(
                        "playwright_driver_corrompido",
                        f"♻️ Driver Playwright corrompido no keep-alive; reiniciando do zero: {type(e).__name__}: {e}",
                        5,
                    )
                    fechar_navegador(sessao, corrompido=True)
                    raise
                if isinstance(e, PlaywrightTimeoutError):
                    registrar_erro_limitado(
                        "playwright_keep_alive_timeout",
                        f"⚠️ Timeout no keep-alive do Playwright: {e}",
                        15,
                    )
                else:
                    registrar_erro_limitado(
                        "playwright_keep_alive",
                        f"⚠️ Falha no keep-alive do Playwright: {type(e).__name__}: {e}",
                        15,
                    )
            continue

        # Ctrl+C bloqueia o início de uma nova tarefa que ainda estava na fila.
        # Uma operação já dentro de processar_comando_playwright continua até
        # atingir seu estado terminal, preservando o fail-closed financeiro.
        if encerrar_executor.is_set():
            return

        try:
            processar_comando_playwright(p, sessao, comando)
            sessao["ultima_manutencao"] = time.monotonic()
        except Exception as e:
            if erro_driver_playwright(e):
                registrar_erro_limitado(
                    "playwright_driver_corrompido",
                    f"♻️ Driver Playwright corrompido durante comando Redis; reiniciando do zero: {type(e).__name__}: {e}",
                    5,
                )
                fechar_navegador(sessao, corrompido=True)
                raise
            if isinstance(e, PlaywrightTimeoutError):
                registrar_erro_limitado(
                    "playwright_timeout_comando",
                    f"⚠️ Timeout ao processar comando Redis: {e}",
                    10,
                )
            else:
                registrar_erro_limitado(
                    "playwright_comando",
                    f"❌ Falha ao processar comando Redis {comando.get('action')}: {type(e).__name__}: {e}",
                    10,
                )
        finally:
            # O timeout de 5 minutos passa a contar da conclusao real da tarefa.
            registrar_atividade_node()


def worker_playwright():
    reabrir_apos_falha_driver = False

    while not encerrar_executor.is_set():
        sessao = {"browser": None, "context": None, "page": None, "ultima_manutencao": 0.0}
        try:
            with sync_playwright() as p:
                if reabrir_apos_falha_driver:
                    try:
                        page, context = garantir_navegador(p, sessao)
                        garantir_destino_final_mesa(page, context)
                        sessao["ultima_manutencao"] = time.monotonic()
                        reabrir_apos_falha_driver = False
                        print("✅ Playwright reinicializado do zero e mesa restaurada.")
                    except Exception as e:
                        if erro_driver_playwright(e):
                            fechar_navegador(sessao, corrompido=True)
                            raise
                        registrar_erro_limitado(
                            "playwright_reabertura",
                            f"⚠️ Driver reiniciado, mas a mesa ainda nao abriu: {type(e).__name__}: {e}",
                            15,
                        )
                        fechar_navegador(sessao)
                        reabrir_apos_falha_driver = False

                ciclo_playwright(p, sessao)
        except Exception as e:
            if erro_driver_playwright(e):
                reabrir_apos_falha_driver = True
                time.sleep(DRIVER_RECOVERY_DELAY_SECONDS)
                continue

            registrar_erro_limitado(
                "playwright_worker",
                f"⚠️ Worker Playwright reiniciado apos falha inesperada: {type(e).__name__}: {e}",
                15,
            )
            fechar_navegador(sessao)
            time.sleep(DRIVER_RECOVERY_DELAY_SECONDS)


def exibir_painel_versao():
    print("=" * 60)
    print("🤖 ROBO BAC BO EVOLUTION - EXECUTOR REDIS-ONLY")
    print(f"🏷️ VERSAO: {VERSAO_ROBO} | {NOME_ATUALIZACAO}")
    print(f"🎧 Canal de comandos: {REDIS_COMMAND_CHANNEL}")
    print(f"⚙️ AUTO_TRADER_ENABLED={AUTO_TRADER_ENABLED}")
    print(f"🛡️ Idempotência física: últimos {IDEMPOTENCY_CACHE_MAX} order_id(s) terminais em memória.")
    print("🧠 Sem Flask, sem WebSocket da mesa e sem captura de resultados.")
    print("=" * 60)


def executar_main():
    encerrar_executor.clear()

    exibir_painel_versao()

    thread_playwright = threading.Thread(
        target=worker_playwright,
        name="bacbo-playwright-worker",
        daemon=True,
    )

    thread_redis = threading.Thread(
        target=ouvir_comandos_redis,
        name="bacbo-redis-listener",
        daemon=True,
    )

    thread_playwright.start()
    thread_redis.start()

    try:
        # O main thread fica deliberadamente fora do socket Redis.
        # Assim o Windows consegue entregar KeyboardInterrupt ao Python.
        while not encerrar_executor.wait(0.5):
            if not thread_redis.is_alive():
                print(
                    "⚠️ Listener Redis encerrou inesperadamente; "
                    "encerrando executor."
                )
                break

    except KeyboardInterrupt:
        print(
            "\n🛑 Ctrl+C recebido; solicitando encerramento seguro."
        )

    finally:
        solicitar_encerramento_executor()

        # Nunca mata o processo no meio de uma aposta física.
        # O listener já está lacrado para novas ordens; se uma ordem havia
        # começado, aguardamos processar_comando_playwright atingir terminal.
        if auto_trader_operando.is_set():
            print(
                "⏳ Operação financeira em curso; aguardando conclusão "
                "segura antes de encerrar."
            )

        while auto_trader_operando.is_set():
            try:
                time.sleep(0.10)
            except KeyboardInterrupt:
                print(
                    "⚠️ Encerramento já solicitado; operação financeira "
                    "ainda em curso e não será interrompida no meio."
                )

        thread_redis.join(
            timeout=3.0
        )

        thread_playwright.join(
            timeout=5.0
        )

        print(
            "👋 Executor Redis encerrado."
        )


if __name__ == "__main__":
    executar_main()
