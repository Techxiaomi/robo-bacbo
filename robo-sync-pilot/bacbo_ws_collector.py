import json
import os
import queue
import re
import socket
import ssl
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse

BACBO_EVENTS_CHANNEL = "bacbo_events"
ROAD_SNAPSHOT_KEY = "robo_bacbo:last_road_snapshot"
_FRAME_QUEUE_MAX = 5000
_DEDUP_MAX = 5000

_instalado = False
_worker_iniciado = False
_frame_queue = queue.Queue(maxsize=_FRAME_QUEUE_MAX)
_seen_live = {}
_seen_lock = threading.Lock()
_avisos = {}

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _env_bool(nome, padrao=False):
    bruto = str(os.getenv(nome, "1" if padrao else "0") or "").strip().lower()
    return bruto in {"1", "true", "yes", "on", "sim"}


def _agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _log_limitado(chave, mensagem, intervalo=15.0):
    agora = time.time()
    ultimo = float(_avisos.get(chave, 0.0) or 0.0)
    if agora - ultimo >= float(intervalo):
        print(mensagem)
        _avisos[chave] = agora


def _normalizar_tipo(valor):
    if isinstance(valor, bool):
        return None
    if isinstance(valor, (int, float)) and float(valor).is_integer():
        return {1: "PLAYER", 2: "BANKER", 3: "TIE"}.get(int(valor))
    texto = str(valor or "").strip().upper()
    if texto in {"1", "PLAYER", "PLAYERWON", "P", "JOGADOR", "AZUL"}:
        return "PLAYER"
    if texto in {"2", "BANKER", "BANKERWON", "B", "BANCA", "VERMELHO"}:
        return "BANKER"
    if texto in {"3", "TIE", "TIEWON", "T", "DRAW", "EMPATE"}:
        return "TIE"
    return None


def _numero(valor):
    if valor is None or isinstance(valor, bool):
        return None
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        return None
    if not (numero == numero) or numero in (float("inf"), float("-inf")):
        return None
    return int(numero) if numero.is_integer() else numero


def _normalizar_instant(valor):
    if valor is None or valor == "":
        return _agora_iso()
    if isinstance(valor, (int, float)) and not isinstance(valor, bool):
        numero = float(valor)
        if numero < 10_000_000_000:
            numero *= 1000.0
        try:
            return datetime.fromtimestamp(numero / 1000.0, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except Exception:
            return _agora_iso()
    texto = str(valor).strip()
    if not texto:
        return _agora_iso()
    return texto


def _uuid_canonico(valor, fallback):
    bruto = str(valor or "").strip().lower()
    if _UUID_RE.fullmatch(bruto):
        return bruto
    base = bruto or str(fallback or "").strip()
    if not base:
        base = f"bacbo-{time.time_ns()}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"bacbo:{base}"))


def _config_redis():
    redis_url = str(os.getenv("REDIS_URL", "redis://127.0.0.1:6379") or "").strip() or "redis://127.0.0.1:6379"
    parsed = urlparse(redis_url)
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


def _resp(*partes):
    itens = []
    for parte in partes:
        bruto = parte if isinstance(parte, bytes) else str(parte).encode("utf-8")
        itens.append(b"$" + str(len(bruto)).encode("ascii") + b"\r\n" + bruto + b"\r\n")
    return b"*" + str(len(itens)).encode("ascii") + b"\r\n" + b"".join(itens)


def _ler_exato(stream, tamanho):
    partes = []
    restante = int(tamanho)
    while restante > 0:
        bloco = stream.read(restante)
        if not bloco:
            raise ConnectionError("Redis encerrou a conexao")
        partes.append(bloco)
        restante -= len(bloco)
    return b"".join(partes)


def _ler_resp(stream):
    prefixo = stream.read(1)
    if not prefixo:
        raise ConnectionError("Redis encerrou a conexao")
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
        dados = _ler_exato(stream, tamanho)
        _ler_exato(stream, 2)
        return dados
    if prefixo == b"*":
        quantidade = int(corpo)
        return [_ler_resp(stream) for _ in range(max(0, quantidade))]
    raise RuntimeError(f"Resposta Redis desconhecida: {prefixo!r}")


def _redis_exec(*partes):
    cfg = _config_redis()
    sock = socket.create_connection((cfg["host"], cfg["port"]), timeout=3.0)
    if cfg["tls"]:
        contexto = ssl.create_default_context()
        sock = contexto.wrap_socket(sock, server_hostname=cfg["host"])
    sock.settimeout(3.0)
    stream = sock.makefile("rb")
    try:
        if cfg["password"]:
            auth = ("AUTH", cfg["username"], cfg["password"]) if cfg["username"] else ("AUTH", cfg["password"])
            sock.sendall(_resp(*auth))
            _ler_resp(stream)
        if cfg["db"]:
            sock.sendall(_resp("SELECT", cfg["db"]))
            _ler_resp(stream)
        sock.sendall(_resp(*partes))
        return _ler_resp(stream)
    finally:
        try:
            stream.close()
        finally:
            sock.close()


def _publicar(payload):
    mensagem = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    resposta = _redis_exec("PUBLISH", BACBO_EVENTS_CHANNEL, mensagem)
    return int(resposta or 0)


def _reter_snapshot(payload):
    mensagem = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    _redis_exec("SET", ROAD_SNAPSHOT_KEY, mensagem)


def _marcar_live(uuid_round):
    with _seen_lock:
        if uuid_round in _seen_live:
            return False
        _seen_live[uuid_round] = time.time()
        while len(_seen_live) > _DEDUP_MAX:
            primeira = next(iter(_seen_live))
            del _seen_live[primeira]
    return True


def _parse_frame(payload):
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, bytes):
        texto = payload.decode("utf-8", errors="replace")
    else:
        texto = str(payload or "")
    texto = texto.strip()
    if not texto:
        return None
    candidatos = [texto]
    limpo = re.sub(r"^\d+", "", texto)
    if limpo != texto:
        candidatos.append(limpo)
    for candidato in candidatos:
        try:
            return json.loads(candidato)
        except Exception:
            continue
    return None


def _dicts(valor, profundidade=0):
    if profundidade > 6:
        return
    if isinstance(valor, dict):
        yield valor
        for filho in valor.values():
            if isinstance(filho, (dict, list)):
                yield from _dicts(filho, profundidade + 1)
    elif isinstance(valor, list):
        for filho in valor:
            if isinstance(filho, (dict, list)):
                yield from _dicts(filho, profundidade + 1)


def _normalizar_history_road(history):
    if not isinstance(history, list) or not history:
        return None
    normalizados = []
    for item in history[:1000]:
        if not isinstance(item, dict):
            return None
        tipo = _normalizar_tipo(item.get("winner") or item.get("type") or item.get("vencedor"))
        player_score = _numero(item.get("playerScore", item.get("player_score")))
        banker_score = _numero(item.get("bankerScore", item.get("banker_score")))
        if tipo is None or player_score is None or banker_score is None:
            return None
        if not 0 <= float(player_score) <= 12 or not 0 <= float(banker_score) <= 12:
            return None
        winner = {"PLAYER": "Player", "BANKER": "Banker", "TIE": "Tie"}[tipo]
        normalizados.append({
            "winner": winner,
            "playerScore": player_score,
            "bankerScore": banker_score,
        })
    return normalizados


def _normalizar_history_novo(history):
    if not isinstance(history, list) or not history:
        return None
    saida = []
    for item in history[:1000]:
        if not isinstance(item, dict):
            return None
        if not all(chave in item for chave in ("uuid", "type", "result")):
            return None
        tipo = _normalizar_tipo(item.get("type"))
        resultado = _numero(item.get("result"))
        if tipo is None or resultado is None:
            return None
        instant = _normalizar_instant(item.get("instant"))
        uid = _uuid_canonico(item.get("uuid"), f"{instant}|{tipo}|{resultado}")
        saida.append({"uuid": uid, "type": tipo, "result": resultado, "instant": instant})
    return saida


def _publicar_history(history, origem):
    novo = _normalizar_history_novo(history)
    legado = None if novo is not None else _normalizar_history_road(history)
    itens = novo if novo is not None else legado
    if not itens:
        return False
    evento = {
        "action": "history_snapshot",
        "source": origem,
        "instant": _agora_iso(),
        "history": itens,
    }
    try:
        _reter_snapshot(evento)
        receptores = _publicar(evento)
        print(f"📚 BACBO ROAD -> Redis | {len(itens)} histórico(s) | origem={origem} | subscribers={receptores}.")
        return True
    except Exception as e:
        _log_limitado("road_redis", f"⚠️ Falha ao publicar/reter histórico BacBo no Redis: {type(e).__name__}: {e}")
        return False


def _extrair_history(mensagem):
    for dados in _dicts(mensagem):
        tipo = str(dados.get("type") or "").strip().lower()
        if tipo == "bacbo.road":
            args = dados.get("args") if isinstance(dados.get("args"), dict) else {}
            history = args.get("history")
            if isinstance(history, list) and history:
                return history, "bacbo.road"
        history = dados.get("history")
        if isinstance(history, list) and history:
            if _normalizar_history_novo(history) is not None or _normalizar_history_road(history) is not None:
                return history, "history"
        args = dados.get("args") if isinstance(dados.get("args"), dict) else {}
        history = args.get("history")
        if isinstance(history, list) and history:
            if _normalizar_history_novo(history) is not None or _normalizar_history_road(history) is not None:
                return history, "args.history"
    return None, None


def _live_schema_direto(mensagem):
    candidatos = []
    if isinstance(mensagem, dict):
        candidatos.append(mensagem)
        for chave in ("data", "payload", "event"):
            valor = mensagem.get(chave)
            if isinstance(valor, dict):
                candidatos.append(valor)
    elif isinstance(mensagem, list):
        candidatos.extend(item for item in mensagem if isinstance(item, dict))

    for dados in candidatos:
        if not all(chave in dados for chave in ("uuid", "type", "result")):
            continue
        tipo = _normalizar_tipo(dados.get("type"))
        resultado = _numero(dados.get("result"))
        if tipo is None or resultado is None:
            continue
        instant = _normalizar_instant(dados.get("instant"))
        uid = _uuid_canonico(dados.get("uuid"), f"{instant}|{tipo}|{resultado}")
        return {"uuid": uid, "type": tipo, "result": resultado, "instant": instant}
    return None


def _score_lado(game, tipo):
    scores = game.get("scores") if isinstance(game.get("scores"), dict) else {}
    if tipo == "PLAYER":
        candidatos = (
            game.get("playerScore"), game.get("player_score"), game.get("playerPoints"),
            scores.get("playerScore"), scores.get("player"),
        )
    else:
        candidatos = (
            game.get("bankerScore"), game.get("banker_score"), game.get("bankerPoints"),
            scores.get("bankerScore"), scores.get("banker"),
        )
    for candidato in candidatos:
        numero = _numero(candidato)
        if numero is not None and 0 <= float(numero) <= 12:
            return numero
    return None


def _score_por_dice(game, tipo):
    dice = game.get("dice")
    if not isinstance(dice, list):
        return None
    por_id = {}
    for item in dice:
        if not isinstance(item, dict):
            continue
        try:
            identificador = int(item.get("id"))
            valor = int(item.get("value"))
        except (TypeError, ValueError):
            continue
        if identificador in {1, 2, 3, 4} and 1 <= valor <= 6:
            por_id[identificador] = valor
    if tipo == "PLAYER" and 1 in por_id and 3 in por_id:
        return por_id[1] + por_id[3]
    if tipo == "BANKER" and 2 in por_id and 4 in por_id:
        return por_id[2] + por_id[4]
    if tipo == "TIE" and all(i in por_id for i in (1, 2, 3, 4)):
        jogador = por_id[1] + por_id[3]
        banca = por_id[2] + por_id[4]
        return jogador if jogador == banca else None
    return None


def _live_player_state(mensagem):
    for dados in _dicts(mensagem):
        if str(dados.get("type") or "").strip().lower() != "bacbo.playerstate":
            continue
        args = dados.get("args") if isinstance(dados.get("args"), dict) else {}
        game = args.get("game") if isinstance(args.get("game"), dict) else {}
        if str(game.get("stage") or "").strip().lower() != "resolved":
            continue
        tipo = _normalizar_tipo(game.get("result") or game.get("winner"))
        if tipo is None:
            return None
        soma = _score_lado(game, "PLAYER" if tipo == "TIE" else tipo)
        if soma is None:
            soma = _score_por_dice(game, tipo)
        if soma is None:
            _log_limitado(
                "playerstate_sem_soma",
                f"⚠️ bacbo.playerState Resolved recebido sem soma utilizável | winner={tipo}; rodada não publicada.",
                10,
            )
            return None
        identificador = (
            game.get("uuid") or game.get("roundId") or game.get("round_id")
            or game.get("roundUid") or args.get("roundId") or dados.get("uuid")
        )
        instant = _normalizar_instant(
            game.get("instant") or game.get("resolvedAt") or game.get("timestamp")
            or dados.get("instant") or dados.get("timestamp")
        )
        uid = _uuid_canonico(identificador, f"{instant}|{tipo}|{soma}")
        return {"uuid": uid, "type": tipo, "result": soma, "instant": instant}
    return None


def _publicar_live(round_data, origem):
    if not round_data:
        return False
    uid = str(round_data.get("uuid") or "")
    if not _marcar_live(uid):
        return False
    evento = {"action": "live_round", "source": origem, "data": round_data}
    try:
        receptores = _publicar(evento)
        if receptores < 1:
            print(f"⚠️ BACBO LIVE sem subscriber Redis | uuid={uid} | type={round_data['type']} | soma={round_data['result']}.")
        else:
            print(f"📤 BACBO LIVE -> Redis | uuid={uid} | type={round_data['type']} | soma={round_data['result']} | subscribers={receptores}.")
        return receptores > 0
    except Exception as e:
        _log_limitado("live_redis", f"⚠️ Falha ao publicar rodada BacBo no Redis: {type(e).__name__}: {e}", 10)
        return False


def _processar_frame(payload):
    mensagem = _parse_frame(payload)
    if mensagem is None:
        return

    history, origem_history = _extrair_history(mensagem)
    if history is not None:
        _publicar_history(history, origem_history)
        return

    live = _live_schema_direto(mensagem)
    if live is not None:
        _publicar_live(live, "tipminer-schema")
        return

    live = _live_player_state(mensagem)
    if live is not None:
        _publicar_live(live, "bacbo.playerState")


def _worker():
    while True:
        payload = _frame_queue.get()
        try:
            _processar_frame(payload)
        except Exception as e:
            _log_limitado("frame_worker", f"⚠️ Coletor BacBo falhou ao processar frame: {type(e).__name__}: {e}", 10)


def _enfileirar_frame(payload):
    try:
        _frame_queue.put_nowait(payload)
    except queue.Full:
        _log_limitado("frame_queue_cheia", "⚠️ Fila do coletor BacBo cheia; frame descartado para preservar o executor.", 10)


def _anexar_page(page):
    if getattr(page, "_bacbo_collector_attached", False):
        return
    setattr(page, "_bacbo_collector_attached", True)

    def on_websocket(ws):
        try:
            ws.on("framereceived", _enfileirar_frame)
        except Exception as e:
            _log_limitado("ws_attach", f"⚠️ Falha ao anexar frame receiver BacBo: {type(e).__name__}: {e}", 10)

    page.on("websocket", on_websocket)
    print("✅ Coletor BacBo WebSocket anexado à página Evolution; ROAD + LIVE serão publicados em bacbo_events.")


def instalar_coletor_bacbo():
    global _instalado, _worker_iniciado
    if _instalado:
        return True
    if not _env_bool("BACBO_COLLECTOR_ENABLED", True):
        print("ℹ️ BACBO_COLLECTOR_ENABLED=0; captura de ROAD/LIVE desativada.")
        return False

    # No executor atual AUTO_TRADER_ENABLED controla apenas a manutenção contínua
    # do navegador. Mantemos a mesa aberta para o coletor mesmo sem ordens.
    os.environ["AUTO_TRADER_ENABLED"] = "1"

    from playwright.sync_api import BrowserContext

    original_new_page = BrowserContext.new_page
    if not getattr(original_new_page, "_bacbo_wrapped", False):
        def new_page_com_coletor(self, *args, **kwargs):
            page = original_new_page(self, *args, **kwargs)
            _anexar_page(page)
            return page

        new_page_com_coletor._bacbo_wrapped = True
        BrowserContext.new_page = new_page_com_coletor

    if not _worker_iniciado:
        threading.Thread(target=_worker, name="bacbo-ws-collector", daemon=True).start()
        _worker_iniciado = True

    _instalado = True
    print("🔌 Coletor BacBo restaurado: WebSocket Evolution -> bacbo_events + retenção ROAD no Redis.")
    return True
