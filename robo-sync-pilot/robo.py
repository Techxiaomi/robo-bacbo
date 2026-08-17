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
from env_loader import load_env_file

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

# ====================================================================
# CONFIGURAÇÕES GERAIS E CONTROLE DE VERSÃO
# ====================================================================
VERSAO_ROBO = "v1.5"
NOME_ATUALIZACAO = "Motor Completo + Anti-Duplicidade (Strict Mode Bypass)"

URL_CASSINO = os.getenv("CASINO_GAME_URL", "")
ARQUIVO_SESSAO = os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json"))

USUARIO_CASSINO = os.getenv("CASINO_USER", "")
SENHA_CASSINO = os.getenv("CASINO_PASSWORD", "")
WEBHOOK_JS = os.getenv("NODE_WEBHOOK_URL", "http://127.0.0.1:3000/receber-sinal")
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()
EXECUTOR_HOST = os.getenv("EXECUTOR_HOST", "127.0.0.1").strip() or "127.0.0.1"
EXECUTOR_PORT = int(os.getenv("EXECUTOR_PORT", "5000"))
CASINO_BALANCE_SELECTOR = os.getenv("CASINO_BALANCE_SELECTOR", "").strip()

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
ORDEM_ID_LIMITE_MEMORIA = 5000
app = Flask(__name__)
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR) # Oculta os logs técnicos do Flask no terminal

def requisicao_interna_autorizada():
    token_recebido = request.headers.get("X-Internal-Token", "")
    return hmac.compare_digest(token_recebido, INTERNAL_API_TOKEN)

def registrar_ordem_idempotente(dados):
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

        ordens_executor_recebidas[order_id] = ordem_normalizada
        while len(ordens_executor_recebidas) > ORDEM_ID_LIMITE_MEMORIA:
            primeiro_id = next(iter(ordens_executor_recebidas))
            del ordens_executor_recebidas[primeiro_id]

        fila_apostas.put(ordem_normalizada)

    return "nova", ordem_normalizada

@app.route('/apostar', methods=['POST'])
def receber_aposta():
    """Recebe uma ordem autenticada do Node.js e coloca na fila do Playwright."""
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

    resultado_idempotencia, ordem = registrar_ordem_idempotente({
        "order_id": order_id,
        "alvo": alvo,
        "valor": valor
    })

    if resultado_idempotencia == "conflito":
        return jsonify({
            "erro": "order_id reutilizado com payload diferente",
            "dados": ordem
        }), 409

    if resultado_idempotencia == "duplicada":
        print(f"\n♻️ ORDEM JA RECEBIDA: {order_id} - fila preservada sem duplicar aposta")
        return jsonify({
            "status": "Ordem ja recebida; fila preservada",
            "duplicada": True,
            "dados": ordem
        }), 200

    print(f"\n📥 ORDEM AUTENTICADA DO NODE.JS: {order_id} - Apostar R$ {valor} no alvo {alvo}")
    return jsonify({
        "status": "Aposta na fila de execucao!",
        "duplicada": False,
        "dados": ordem
    }), 200

def iniciar_servidor_flask():
    app.run(host=EXECUTOR_HOST, port=EXECUTOR_PORT, debug=False, use_reloader=False)

# Inicia o Flask em segundo plano para não travar o robô principal
threading.Thread(target=iniciar_servidor_flask, daemon=True).start()

ultimo_tempo_rodada = 0
avisos_erro_limitados = {}

def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
    agora = time.time()
    ultimo = avisos_erro_limitados.get(chave, 0.0)
    if agora - ultimo >= intervalo_segundos:
        print(mensagem)
        avisos_erro_limitados[chave] = agora

# ====================================================================
# FUNÇÕES CORE DO ROBÔ (Navegação, Login e Apostas)
# ====================================================================
def exibir_painel_versao():
    print("="*60)
    print(f"🤖 ROBÔ BAC BO EVOLUTION - MOTOR DE EXECUÇÃO")
    print(f"🏷️ VERSÃO: {VERSAO_ROBO} | {NOME_ATUALIZACAO}")
    print(f"🎧 Escutando ordens autenticadas em {EXECUTOR_HOST}:{EXECUTOR_PORT}...")
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

def executar_aposta_na_tela(page, aposta):
    """Cérebro de Apostas com Bypass do Strict Mode (adicionado .first)."""
    try:
        alvo_bruto = aposta.get("alvo")
        valor_total = int(aposta.get("valor", 0))

        mapa_alvos = {
            "PlayerWon": "bacbo-bet-spot-Player",
            "BankerWon": "bacbo-bet-spot-Banker",
            "Tie": "bacbo-bet-spot-Tie"
        }
        seletor_alvo = mapa_alvos.get(alvo_bruto)
        
        if not seletor_alvo:
            print(f"❌ Erro: Alvo '{alvo_bruto}' não mapeado.")
            return

        frame_jogo = None
        for frame in page.frames:
            if "evolution" in frame.url.lower() or "evocdn" in frame.url.lower() or "game" in frame.url.lower():
                frame_jogo = frame
                if frame.locator("div[data-role='chip']").count() > 0:
                    break
                
        if not frame_jogo:
            print("❌ Erro: Iframe da mesa não encontrado! A tela pode estar carregando.")
            return

        fichas_disponiveis = [5000, 2500, 500, 125, 25, 10, 5]
        valor_restante = valor_total
        cliques_necessarios = []

        for ficha in fichas_disponiveis:
            qtd = valor_restante // ficha
            if qtd > 0:
                cliques_necessarios.append((ficha, qtd))
                valor_restante %= ficha

        if valor_restante > 0 and not cliques_necessarios:
            print(f"⚠️ Aposta ignorada: R$ {valor_total} é menor que a ficha mínima da mesa.")
            return

        sucesso_total = True

        for ficha, qtd in cliques_necessarios:
            seletor_ficha = f"div[data-role='chip'][data-value='{ficha}']"
            
            try:
                # CORREÇÃO AQUI: Adicionado o .first para pegar apenas a primeira ficha da tela
                ficha_elemento = frame_jogo.locator(seletor_ficha).first
                
                # Aguarda a primeira ficha ficar visível
                ficha_elemento.wait_for(state="visible", timeout=3000)
                
                # Clica na ficha selecionada
                ficha_elemento.click(force=True)
                page.wait_for_timeout(200) # Pausa humanizada
                
                # CORREÇÃO AQUI: Adicionado o .first para pegar apenas o primeiro alvo da tela
                alvo_elemento = frame_jogo.locator(f"[data-role='{seletor_alvo}']").first
                for _ in range(qtd):
                    alvo_elemento.click(force=True)
                    page.wait_for_timeout(150) # Pausa humanizada entre cliques
                    
            except PlaywrightTimeoutError:
                sucesso_total = False
                print(f"⚠️ Tempo esgotado: A ficha de {ficha} não apareceu. (As apostas fecharam?)")
            except Exception as e:
                sucesso_total = False
                print(f"⚠️ Falha inesperada ao clicar na mesa: {e}")

        # Mensagem final de sucesso
        if sucesso_total:
            valor_final_apostado = valor_total - valor_restante
            print(f"🎯 SUCESSO! Aposta de R$ {valor_final_apostado} no {alvo_bruto} confirmada com clique duplo!")
        else:
            print("❌ Aposta abortada ou incompleta devido a bloqueios na mesa.")

    except Exception as e:
        print(f"❌ Erro grave na engine de aposta: {e}")

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
    global ultimo_tempo_rodada
    try:
        game_info = dados.get("args", {}).get("game", {})
        status_atual = game_info.get("stage")

        if status_atual == "Resolved":
            resultado_bruto = game_info.get("result", "")
            resultado = "Tie" if "Tie" in resultado_bruto else resultado_bruto
            
            tempo_atual = time.time()
            valores_dados = {1: 0, 2: 0, 3: 0, 4: 0}
            for d in game_info.get("dice", []):
                valores_dados[d.get("id")] = d.get("value", 0)
            
            soma_jogador = valores_dados[1] + valores_dados[3]
            soma_banca = valores_dados[2] + valores_dados[4]

            houve_interrupcao = ultimo_tempo_rodada > 0 and (tempo_atual - ultimo_tempo_rodada) > 60
            ultimo_tempo_rodada = tempo_atual

            payload = {
                "vencedor": resultado,
                "resultado_bruto": resultado_bruto,
                "pontos_jogador": soma_jogador,
                "pontos_banca": soma_banca,
                "dados_jogador": [valores_dados[1], valores_dados[3]],
                "dados_banca": [valores_dados[2], valores_dados[4]],
                "interrupcao_fluxo": houve_interrupcao,
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
            except Exception as e:
                registrar_erro_limitado(
                    "resultado_node",
                    f"❌ Falha ao enviar resultado resolvido ao Node: {type(e).__name__}: {e}",
                    30
                )

            print("\n====================================")
            if houve_interrupcao: print("⚠️ [ALERTA] Interrupção de Sequência (> 60s)")
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
        status_conexao = {"ativa": True, "ws_conectado": False}
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
                status_conexao["ativa"] = True
                status_conexao["ws_conectado"] = True
                ws.on("framereceived", capturar_frame)
                ws.on("close", lambda ws: status_conexao.update({"ativa": False, "ws_conectado": False}))

        def capturar_frame(texto):
            try:
                if not texto or not isinstance(texto, str): return
                texto_limpo = re.sub(r'^\d+', '', texto)
                if not texto_limpo: return
                dados = json.loads(texto_limpo)
                if dados.get("type") == "bacbo.playerState":
                    processar_resultado(dados)
            except json.JSONDecodeError:
                pass
            except Exception as e:
                registrar_erro_limitado(
                    "capturar_frame",
                    f"⚠️ Falha inesperada ao processar frame WebSocket: {type(e).__name__}: {e}",
                    30
                )

        page.on("websocket", on_web_socket)

        while True:
            try:
                status_conexao["ws_conectado"] = False
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

                print("✅ Acesso validado! Tudo pronto.")
                
                tempo_passado = 0
                while tempo_passado < (2 * 60 * 60 * 1000): # Reinicia a cada 2 horas
                    if not status_conexao["ativa"]: break
                    
                    # CÉREBRO DE EXECUÇÃO: Checa a fila de apostas frequentemente
                    for _ in range(20):
                        sincronizar_saldo_com_node(page, estado_saldo)
                        if not fila_apostas.empty():
                            ordem = fila_apostas.get()
                            executar_aposta_na_tela(page, ordem)
                        page.wait_for_timeout(500)
                    
                    # Clica no botão 'Continuar' caso a mesa fique inativa para você
                    for frame in page.frames:
                        if "evolution" in frame.url.lower() or "evocdn" in frame.url.lower() or "game" in frame.url.lower():
                            try:
                                btn = frame.get_by_text(re.compile(r"continuar|continue", re.IGNORECASE))
                                if btn.count() > 0 and btn.first.is_visible(): btn.first.click(force=True)
                            except: pass
                    
                    tempo_passado += 10000
                
            except PlaywrightTimeoutError as e:
                registrar_erro_limitado(
                    "loop_timeout",
                    f"⚠️ Timeout no loop principal do Playwright: {e}",
                    30
                )
                time.sleep(10)
            except Exception as e:
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
            print("\n👋 Robô desligado com sucesso.")
            break
        except Exception as e:
            print(f"🔥 Executor reiniciando após falha não tratada: {type(e).__name__}: {e}")
            time.sleep(15)
