from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
import threading
import queue
import time
import re
import json
import os
import socket
import ssl
from urllib.parse import urlparse, unquote
from env_loader import load_env_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

# ====================================================================
# CONFIGURACAO REDIS-ONLY DO EXECUTOR
# ====================================================================
VERSAO_ROBO = "v1.6.14"
NOME_ATUALIZACAO = "Executor Redis-Only + Idle Timeout"

URL_CASSINO = os.getenv("CASINO_GAME_URL", "")
URL_HOME_CASSINO = os.getenv("CASINO_HOME_URL", "")
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))
USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
CASINO_BALANCE_SELECTOR = os.getenv("CASINO_BALANCE_SELECTOR", "").strip()
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379").strip() or "redis://127.0.0.1:6379"
REDIS_COMMAND_CHANNEL = "auto_trader_commands"
REDIS_RESPONSE_CHANNEL = "auto_trader_responses"
BROWSER_IDLE_TIMEOUT_SECONDS = 300.0
EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS = 8.0
EXECUTOR_BET_ACCEPTANCE_TOLERANCE = 0.10

fila_comandos_redis = queue.Queue()
auto_trader_operando = threading.Event()
navegador_aberto = threading.Event()
atividade_node_lock = threading.Lock()
ultima_atividade_node_monotonic = time.monotonic()
avisos_erro_limitados = {}


def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
    agora = time.time()
    ultimo = avisos_erro_limitados.get(chave, 0.0)
    if agora - ultimo >= intervalo_segundos:
        print(mensagem)
        avisos_erro_limitados[chave] = agora


def registrar_atividade_node():
    global ultima_atividade_node_monotonic
    with atividade_node_lock:
        ultima_atividade_node_monotonic = time.monotonic()


def segundos_inatividade_node():
    with atividade_node_lock:
        ultima = float(ultima_atividade_node_monotonic)
    return max(0.0, time.monotonic() - ultima)


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


def ouvir_comandos_redis():
    while True:
        sock = None
        stream = None
        try:
            sock, stream = _abrir_conexao_redis(bloqueante=True)
            confirmacao = _enviar_comando_redis(sock, stream, "SUBSCRIBE", REDIS_COMMAND_CHANNEL)
            if not isinstance(confirmacao, list) or len(confirmacao) < 3 or _texto_redis(confirmacao[0]).lower() != "subscribe":
                raise RuntimeError("Redis nao confirmou assinatura de auto_trader_commands")

            print(f"🎧 Redis ativo: aguardando comandos em {REDIS_COMMAND_CHANNEL}.")
            while True:
                resposta = _ler_resposta_redis(stream)
                if not isinstance(resposta, list) or len(resposta) < 3:
                    continue
                if _texto_redis(resposta[0]).lower() != "message":
                    continue
                if _texto_redis(resposta[1]) != REDIS_COMMAND_CHANNEL:
                    continue

                try:
                    dados = json.loads(_texto_redis(resposta[2]))
                except json.JSONDecodeError:
                    continue
                if not isinstance(dados, dict):
                    continue

                registrar_atividade_node()
                acao = str(dados.get("action") or "").strip()
                if acao in {"sync_balance", "place_bet"}:
                    fila_comandos_redis.put(dados)
        except Exception as e:
            registrar_erro_limitado(
                "redis_auto_trader_commands",
                f"⚠️ Redis auto_trader_commands indisponivel: {type(e).__name__}: {e}",
                30,
            )
            time.sleep(2)
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


# ====================================================================
# PLAYWRIGHT: SOMENTE LOGIN, SALDO E EXECUCAO DE ORDEM
# ====================================================================
def aplicar_stealth(page):
    try:
        from playwright_stealth import stealth_sync
        stealth_sync(page)
    except Exception:
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
    except Exception:
        pass
    try:
        btn_sim = page.locator("button", has_text=re.compile(r"^Sim$", re.IGNORECASE))
        if btn_sim.count() == 0:
            btn_sim = page.locator("button", has_text=re.compile(r"Sim", re.IGNORECASE))
        for i in range(min(btn_sim.count(), 8)):
            if btn_sim.nth(i).is_visible():
                btn_sim.nth(i).click(force=True)
                page.wait_for_timeout(500)
                break
    except Exception:
        pass


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
                page.wait_for_timeout(1500)
                email = page.locator("input[name='email']")
                if email.count() > 0 and email.first.is_visible():
                    login_aberto = True
                    break
            except Exception:
                continue

        if not login_aberto:
            email = page.locator("input[name='email']")
            login_aberto = email.count() > 0 and email.first.is_visible()
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
        return True
    except Exception as e:
        registrar_erro_limitado(
            "auto_login",
            f"⚠️ Auto-Login falhou: {type(e).__name__}: {e}",
            30,
        )
        return False


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


def localizar_ficha(frame, valor_ficha):
    candidatos = frame.locator("[data-role='chip'][data-value]")
    try:
        quantidade = min(max(0, int(candidatos.count())), 64)
    except Exception:
        return None

    for indice in range(quantidade):
        candidato = candidatos.nth(indice)
        try:
            valor_bruto = candidato.get_attribute("data-value") or ""
            valor = float(str(valor_bruto).strip().replace(" ", "").replace(",", "."))
            if abs(valor - float(valor_ficha)) >= 0.001 or not candidato.is_visible():
                continue
            return candidato
        except Exception:
            continue
    return None


def localizar_frame_aposta(page, planos):
    for frame in list(page.frames):
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
    except Exception:
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
    saldo_antes = ler_saldo_atual(page)
    if saldo_antes is None:
        raise RuntimeError("Saldo real indisponivel antes da aposta")

    frame = localizar_frame_aposta(page, planos)
    if frame is None:
        raise RuntimeError("Elementos da mesa nao estao disponiveis para a ordem")

    ficha_corrente = None
    cliques_alvo = 0
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
        raise RuntimeError(
            f"Debito financeiro nao confirmado; saldo_antes={saldo_antes}, saldo_depois={saldo_depois}, exposicao={exposicao}"
        )

    print(
        f"✅ Ordem Redis executada: {cliques_alvo} clique(s) financeiro(s); "
        f"saldo R$ {float(saldo_antes):.2f} -> R$ {float(saldo_depois):.2f}."
    )


def _pagina_tem_interface_util(page):
    if CASINO_BALANCE_SELECTOR and ler_saldo_atual(page) is not None:
        return True
    for frame in list(page.frames):
        try:
            if frame.locator("[data-role='chip'][data-value]").count() > 0:
                return True
        except Exception:
            continue
    return False


def garantir_mesa_pronta(page, context):
    if _pagina_tem_interface_util(page):
        return True

    page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
    fechar_popups(page)
    page.wait_for_timeout(2500)
    if _pagina_tem_interface_util(page):
        return True

    if not renovar_sessao_automaticamente(page, context):
        return False

    page.goto(URL_CASSINO, wait_until="domcontentloaded", timeout=60000)
    fechar_popups(page)
    page.wait_for_timeout(2500)
    return _pagina_tem_interface_util(page)


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


def fechar_navegador(sessao):
    context = sessao.get("context")
    browser = sessao.get("browser")
    sessao.update({"browser": None, "context": None, "page": None})
    navegador_aberto.clear()
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
        except Exception:
            pass
        fechar_navegador(sessao)

    browser, context, page = abrir_navegador(p)
    sessao.update({"browser": browser, "context": context, "page": page})
    return page, context


def processar_comando_playwright(p, sessao, comando):
    acao = str(comando.get("action") or "").strip()
    page, context = garantir_navegador(p, sessao)
    if not garantir_mesa_pronta(page, context):
        raise RuntimeError("Nao foi possivel autenticar e abrir a mesa")

    if acao == "sync_balance":
        saldo = ler_saldo_atual(page)
        if saldo is None:
            raise RuntimeError("Saldo real nao localizado na interface")
        publicar_saldo_redis(saldo)
        print(f"💰 Saldo real publicado via Redis: R$ {saldo:.2f}")
        return

    if acao == "place_bet":
        auto_trader_operando.set()
        try:
            executar_place_bet(page, comando)
        finally:
            auto_trader_operando.clear()


def worker_playwright():
    sessao = {"browser": None, "context": None, "page": None}
    with sync_playwright() as p:
        while True:
            try:
                comando = fila_comandos_redis.get(timeout=1.0)
            except queue.Empty:
                if (
                    navegador_aberto.is_set()
                    and not auto_trader_operando.is_set()
                    and fila_comandos_redis.empty()
                    and segundos_inatividade_node() >= BROWSER_IDLE_TIMEOUT_SECONDS
                ):
                    print("🛌 5 minutos sem comandos: fechando navegador e mantendo Redis ativo.")
                    fechar_navegador(sessao)
                continue

            try:
                processar_comando_playwright(p, sessao, comando)
            except PlaywrightTimeoutError as e:
                registrar_erro_limitado(
                    "playwright_timeout_comando",
                    f"⚠️ Timeout ao processar comando Redis: {e}",
                    10,
                )
            except Exception as e:
                registrar_erro_limitado(
                    "playwright_comando",
                    f"❌ Falha ao processar comando Redis {comando.get('action')}: {type(e).__name__}: {e}",
                    10,
                )


def exibir_painel_versao():
    print("=" * 60)
    print("🤖 ROBO BAC BO EVOLUTION - EXECUTOR REDIS-ONLY")
    print(f"🏷️ VERSAO: {VERSAO_ROBO} | {NOME_ATUALIZACAO}")
    print(f"🎧 Canal de comandos: {REDIS_COMMAND_CHANNEL}")
    print("🧠 Sem Flask, sem WebSocket da mesa e sem captura de resultados.")
    print("=" * 60)


if __name__ == "__main__":
    exibir_painel_versao()
    threading.Thread(target=worker_playwright, daemon=True).start()
    try:
        ouvir_comandos_redis()
    except KeyboardInterrupt:
        print("\n👋 Executor Redis encerrado.")
