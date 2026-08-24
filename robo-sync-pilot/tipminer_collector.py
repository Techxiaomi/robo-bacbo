import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone

import redis
import requests
from sseclient import SSEClient

from env_loader import load_env_file


PROJECT_ENV_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_env_file(PROJECT_ENV_PATH)

HISTORY_URL = (
    "https://api.core.public.tipminer.com/v1/bac-bo/rounds/"
    "cc71e81d-8b56-4868-91c7-7224be543dce/history?limit=200"
)
LIVE_URL = (
    "https://api.core.public.tipminer.com/v1/bac-bo/rounds/"
    "cc71e81d-8b56-4868-91c7-7224be543dce/live"
)

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0").strip()
REDIS_HISTORY_KEY = os.getenv("REDIS_BACBO_HISTORY_KEY", "bacbo_history").strip() or "bacbo_history"
REDIS_LATEST_ROUND_KEY = (
    os.getenv("REDIS_BACBO_LATEST_ROUND_KEY", "bacbo_latest_round").strip()
    or "bacbo_latest_round"
)
REDIS_EVENTS_CHANNEL = os.getenv("REDIS_BACBO_EVENTS_CHANNEL", "bacbo_events").strip() or "bacbo_events"

NODE_HOST = os.getenv("NODE_HOST", "127.0.0.1").strip() or "127.0.0.1"
if NODE_HOST in {"0.0.0.0", "::", "[::]"}:
    NODE_HOST = "127.0.0.1"
try:
    NODE_PORT = int(os.getenv("NODE_PORT", "3000"))
except (TypeError, ValueError):
    NODE_PORT = 3000
if NODE_PORT <= 0 or NODE_PORT > 65535:
    NODE_PORT = 3000
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "").strip()
NODE_HEALTH_URL = f"http://{NODE_HOST}:{NODE_PORT}/collector-health"

HISTORY_LIMIT = 200
RECONNECT_DELAY_SECONDS = 3
HTTP_CONNECT_TIMEOUT_SECONDS = 10
HTTP_READ_TIMEOUT_SECONDS = 90
NODE_HEALTH_CONNECT_TIMEOUT_SECONDS = 1.5
NODE_HEALTH_READ_TIMEOUT_SECONDS = 3
CONTINUITY_RETRY_MIN_SECONDS = 1.0
CONTINUITY_RETRY_MAX_SECONDS = 3.0
CONTINUITY_HISTORY_REFRESH_SECONDS = 5.0

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/151.0.0.0 Safari/537.36"
    ),
    "Origin": "https://www.tipminer.com",
    "Referer": "https://www.tipminer.com/",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

VALID_TYPES = {"BANKER", "PLAYER", "TIE"}


class TipMinerCollector:
    def __init__(self):
        if not INTERNAL_API_TOKEN:
            raise RuntimeError(
                "INTERNAL_API_TOKEN ausente; o coletor nao pode operar live sem o handshake de continuidade"
            )

        self.http = requests.Session()
        self.http.headers.update(BROWSER_HEADERS)
        self.node_http = requests.Session()
        self.redis = redis.Redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=HTTP_CONNECT_TIMEOUT_SECONDS,
            socket_timeout=HTTP_READ_TIMEOUT_SECONDS,
            health_check_interval=30,
        )
        self.history = []
        self._pending_interruption = None

    @staticmethod
    def _json_dumps(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _normalize_result(value):
        if isinstance(value, bool) or value is None:
            raise ValueError("result ausente ou invalido")

        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("result nao numerico") from exc

        if not (number == number and number not in (float("inf"), float("-inf"))):
            raise ValueError("result nao finito")

        if number.is_integer():
            return int(number)
        return number

    @staticmethod
    def _extract_round_candidate(payload):
        if not isinstance(payload, dict):
            return None

        required = {"uuid", "type", "result", "instant"}
        if required.issubset(payload.keys()):
            return payload

        for key in ("data", "round", "payload", "item"):
            nested = payload.get(key)
            if isinstance(nested, dict):
                candidate = TipMinerCollector._extract_round_candidate(nested)
                if candidate is not None:
                    return candidate

        return None

    @classmethod
    def _normalize_round(cls, payload):
        item = cls._extract_round_candidate(payload)
        if item is None:
            raise ValueError("payload nao contem uuid/type/result/instant")

        round_uuid = str(item.get("uuid") or "").strip()
        round_type = str(item.get("type") or "").strip().upper()
        instant = str(item.get("instant") or "").strip()

        if not round_uuid:
            raise ValueError("uuid ausente")
        if round_type not in VALID_TYPES:
            raise ValueError(f"type invalido: {round_type or 'vazio'}")
        if not instant:
            raise ValueError("instant ausente")

        return {
            "uuid": round_uuid,
            "type": round_type,
            "result": cls._normalize_result(item.get("result")),
            "instant": instant,
        }

    @staticmethod
    def _extract_history_items(payload):
        if isinstance(payload, list):
            return payload

        if not isinstance(payload, dict):
            raise ValueError("historico Bac Bo nao retornou JSON em lista/objeto")

        for key in ("data", "history", "rounds", "results", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                try:
                    return TipMinerCollector._extract_history_items(value)
                except ValueError:
                    pass

        raise ValueError("lista de giros nao localizada na resposta de historico")

    @staticmethod
    def _instant_sort_value(value):
        text = str(value or "").strip()
        if not text:
            return None

        try:
            numeric = float(text)
            if numeric == numeric and numeric not in (float("inf"), float("-inf")):
                return numeric
        except ValueError:
            pass

        try:
            normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except ValueError:
            return None

    @classmethod
    def _chronological_history(cls, rounds):
        sort_values = [cls._instant_sort_value(item.get("instant")) for item in rounds]
        if all(value is not None for value in sort_values):
            indexed = list(enumerate(rounds))
            indexed.sort(key=lambda pair: (sort_values[pair[0]], pair[0]))
            return [item for _, item in indexed]
        return list(rounds)

    @classmethod
    def _history_signature(cls, rounds):
        digest = hashlib.sha256()
        for item in cls._chronological_history(list(rounds or [])):
            digest.update(str(item.get("uuid") or "").strip().lower().encode("utf-8"))
            digest.update(b"|")
            digest.update(str(item.get("type") or "").strip().upper().encode("utf-8"))
            digest.update(b"|")
            digest.update(str(item.get("result")).encode("utf-8"))
            digest.update(b"|")
            digest.update(str(item.get("instant") or "").strip().encode("utf-8"))
            digest.update(b"\n")
        return f"{len(rounds or [])}|{digest.hexdigest()}"

    @classmethod
    def _history_from_redis_value(cls, raw_value):
        if raw_value is None:
            return []
        try:
            payload = json.loads(str(raw_value))
            items = cls._extract_history_items(payload)
            normalized = [cls._normalize_round(item) for item in items]
            normalized = cls._chronological_history(normalized)
            return normalized[-HISTORY_LIMIT:]
        except (ValueError, TypeError, json.JSONDecodeError):
            return []

    @staticmethod
    def _winner_label(round_type):
        return {
            "PLAYER": "🔵 JOGADOR",
            "BANKER": "🔴 BANCA",
            "TIE": "🟡 EMPATE",
        }.get(str(round_type or "").upper(), "RESULTADO")

    def _queue_interruption(self, reason, force=False):
        if self._pending_interruption is not None and not force:
            return self._pending_interruption

        self._pending_interruption = {
            "evento": "INTERRUPCAO",
            "motivo": str(reason or "INTERRUPCAO_COLETOR")[:120],
            "interrupcao_id": f"bacbo-{os.getpid()}-{uuid.uuid4().hex}",
            "timestamp_coleta": int(time.time() * 1000),
        }
        return self._pending_interruption

    def _try_notify_pending_interruption(self, emit_success=True):
        pending = self._pending_interruption
        if pending is None:
            return True, "sem_pendencia"

        try:
            response = self.node_http.post(
                NODE_HEALTH_URL,
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Token": INTERNAL_API_TOKEN,
                },
                json=pending,
                timeout=(NODE_HEALTH_CONNECT_TIMEOUT_SECONDS, NODE_HEALTH_READ_TIMEOUT_SECONDS),
            )

            body = {}
            try:
                body = response.json() if response.content else {}
            except ValueError:
                body = {}

            if response.ok:
                sinais = int(body.get("sinais_invalidados") or 0)
                traders = int(body.get("traders_bloqueados") or 0)
                motivo = str(pending.get("motivo") or "INTERRUPCAO_COLETOR")
                self._pending_interruption = None
                if emit_success:
                    print(
                        "🛡️ BAC BO | continuidade confirmada pelo Node | "
                        f"motivo={motivo} | sinais={sinais} | traders={traders}."
                    )
                return True, "confirmada"

            if response.status_code == 503:
                return False, "backend_inicializando"
            return False, f"http_{response.status_code}"
        except requests.RequestException as exc:
            return False, f"node_indisponivel:{type(exc).__name__}"

    def _await_pending_interruption_ack(self):
        if self._pending_interruption is None:
            return True

        attempt = 0
        last_history_refresh = time.monotonic()
        last_status = None

        while self._pending_interruption is not None:
            attempt += 1
            ok, status = self._try_notify_pending_interruption(emit_success=True)
            if ok:
                return True

            now = time.monotonic()
            if attempt == 1 or status != last_status or attempt % 10 == 0:
                print(
                    "⏳ BAC BO | continuidade | aguardando confirmação do Node; "
                    f"live bloqueado | estado={status}."
                )
            last_status = status

            if now - last_history_refresh >= CONTINUITY_HISTORY_REFRESH_SECONDS:
                try:
                    self.sync_history(quiet_if_unchanged=True)
                except Exception as exc:
                    print(
                        "⚠️ BAC BO | continuidade | falha ao atualizar histórico durante espera | "
                        f"{type(exc).__name__}: {exc}"
                    )
                last_history_refresh = time.monotonic()

            delay = min(
                CONTINUITY_RETRY_MAX_SECONDS,
                CONTINUITY_RETRY_MIN_SECONDS + ((attempt - 1) * 0.5),
            )
            time.sleep(delay)

        return True

    def _notify_interruption_best_effort(self, reason, force=False):
        self._queue_interruption(reason, force=force)
        ok, status = self._try_notify_pending_interruption(emit_success=True)
        if not ok:
            print(
                "⚠️ BAC BO | continuidade | notificação pendente; "
                f"será reenviada com o mesmo ID | estado={status}."
            )
        return ok

    def _publish_history_sync(self):
        serialized_history = self._json_dumps(self.history)
        event = self._json_dumps({"action": "history_sync"})

        pipeline = self.redis.pipeline(transaction=True)
        pipeline.set(REDIS_HISTORY_KEY, serialized_history)
        pipeline.publish(REDIS_EVENTS_CHANNEL, event)
        pipeline.execute()

    def _publish_live_round(self, round_data):
        existing_index = next(
            (
                index
                for index, item in enumerate(self.history)
                if str(item.get("uuid")) == round_data["uuid"]
            ),
            None,
        )

        if existing_index is not None:
            self.history.pop(existing_index)

        self.history.append(round_data)
        if len(self.history) > HISTORY_LIMIT:
            self.history = self.history[-HISTORY_LIMIT:]

        serialized_round = self._json_dumps(round_data)
        serialized_history = self._json_dumps(self.history)
        event = self._json_dumps({"action": "live_round", "data": round_data})

        pipeline = self.redis.pipeline(transaction=True)
        pipeline.set(REDIS_LATEST_ROUND_KEY, serialized_round)
        pipeline.set(REDIS_HISTORY_KEY, serialized_history)
        pipeline.publish(REDIS_EVENTS_CHANNEL, event)
        pipeline.execute()

    def sync_history(self, quiet_if_unchanged=False):
        response = self.http.get(
            HISTORY_URL,
            headers={"Accept": "application/json"},
            timeout=(HTTP_CONNECT_TIMEOUT_SECONDS, HTTP_READ_TIMEOUT_SECONDS),
        )
        response.raise_for_status()

        payload = response.json()
        raw_items = self._extract_history_items(payload)
        if not raw_items:
            raise ValueError("historico Bac Bo retornou zero giros")

        normalized = [self._normalize_round(item) for item in raw_items]
        normalized = self._chronological_history(normalized)

        if len(normalized) > HISTORY_LIMIT:
            normalized = normalized[-HISTORY_LIMIT:]

        retained_raw = self.redis.get(REDIS_HISTORY_KEY)
        retained_history = self._history_from_redis_value(retained_raw)
        retained_signature = self._history_signature(retained_history) if retained_history else None
        new_signature = self._history_signature(normalized)
        changed = retained_signature != new_signature

        self.history = normalized
        if changed:
            self._publish_history_sync()
            print(f"♻️ BAC BO | HISTÓRICO | {len(self.history)} giro(s) sincronizados.")
        elif not quiet_if_unchanged:
            print(
                f"♻️ BAC BO | HISTÓRICO | {len(self.history)} giro(s) confirmados; "
                "sem alterações."
            )

        return changed

    def listen_live(self):
        response = self.http.get(
            LIVE_URL,
            headers={
                "Accept": "text/event-stream",
                "Connection": "keep-alive",
            },
            stream=True,
            timeout=(HTTP_CONNECT_TIMEOUT_SECONDS, HTTP_READ_TIMEOUT_SECONDS),
        )
        response.raise_for_status()

        content_type = str(response.headers.get("Content-Type") or "").lower()
        if "text/event-stream" not in content_type:
            response.close()
            raise RuntimeError(
                f"Fluxo Bac Bo respondeu Content-Type inesperado: {content_type or 'ausente'}"
            )

        print(f"🎧 BAC BO | LIVE | conectado | Redis={REDIS_EVENTS_CHANNEL}.")

        client = SSEClient(response)
        try:
            for event in client.events():
                raw_data = str(getattr(event, "data", "") or "").strip()
                if not raw_data:
                    continue

                if raw_data.lower() in {"ping", "pong", "heartbeat", "keepalive"}:
                    continue

                try:
                    payload = json.loads(raw_data)
                except json.JSONDecodeError as exc:
                    raise ValueError("evento SSE Bac Bo nao contem JSON valido") from exc

                round_data = self._normalize_round(payload)
                self._publish_live_round(round_data)
                print(
                    f"🎲 BAC BO | {self._winner_label(round_data['type'])} | "
                    f"Soma: {round_data['result']}"
                )
        finally:
            response.close()

        raise ConnectionError("stream SSE Bac Bo encerrou sem excecao")

    def run_forever(self):
        print("============================================================")
        print("📡 COLETOR BAC BO | API -> REDIS")
        print(f"🧠 Histórico Redis: {REDIS_HISTORY_KEY}")
        print(f"📣 Canal Redis: {REDIS_EVENTS_CHANNEL}")
        print("============================================================")

        # Um processo novo nunca herda a continuidade operacional do processo anterior.
        # O mesmo interrupcao_id é mantido até o Node confirmar o recebimento.
        self._queue_interruption("COLETOR_REINICIADO", force=True)

        while True:
            try:
                self.redis.ping()

                # Se o Node já estiver disponível, invalida sinais antigos antes do backfill.
                # Se ainda estiver iniciando, o histórico é atualizado primeiro para que o
                # bootstrap do Node possa recuperar a janela mais recente.
                self._try_notify_pending_interruption(emit_success=True)
                self.sync_history()

                # Fail-closed operacional: nenhum evento live é publicado enquanto o Node
                # não reconhecer explicitamente a quebra de continuidade.
                self._await_pending_interruption_ack()

                # Fecha a janela criada enquanto aguardávamos o Node ficar pronto.
                self.sync_history(quiet_if_unchanged=True)
                self.listen_live()
            except KeyboardInterrupt:
                self._notify_interruption_best_effort("MANUTENCAO_COLETOR", force=True)
                print("\n👋 Coletor Bac Bo encerrado pelo operador.")
                return
            except Exception as exc:
                self._notify_interruption_best_effort("FLUXO_COLETOR_INTERROMPIDO")
                print(
                    "⚠️ BAC BO/REDIS | fluxo interrompido; "
                    f"nova sincronização em {RECONNECT_DELAY_SECONDS}s | "
                    f"{type(exc).__name__}: {exc}"
                )
                time.sleep(RECONNECT_DELAY_SECONDS)


def main():
    TipMinerCollector().run_forever()


if __name__ == "__main__":
    main()
