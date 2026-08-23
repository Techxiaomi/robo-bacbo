import json
import os
import time
from datetime import datetime, timezone

import redis
import requests
from sseclient import SSEClient


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

HISTORY_LIMIT = 200
RECONNECT_DELAY_SECONDS = 3
HTTP_CONNECT_TIMEOUT_SECONDS = 10
HTTP_READ_TIMEOUT_SECONDS = 90

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
        self.http = requests.Session()
        self.http.headers.update(BROWSER_HEADERS)
        self.redis = redis.Redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=HTTP_CONNECT_TIMEOUT_SECONDS,
            socket_timeout=HTTP_READ_TIMEOUT_SECONDS,
            health_check_interval=30,
        )
        self.history = []

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

    @staticmethod
    def _winner_label(round_type):
        return {
            "PLAYER": "🔵 JOGADOR",
            "BANKER": "🔴 BANCA",
            "TIE": "🟡 EMPATE",
        }.get(str(round_type or "").upper(), "RESULTADO")

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

    def sync_history(self):
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

        self.history = normalized
        self._publish_history_sync()
        print(f"♻️ BAC BO | HISTÓRICO | {len(self.history)} giro(s) sincronizados.")

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

        while True:
            try:
                self.redis.ping()
                self.sync_history()
                self.listen_live()
            except KeyboardInterrupt:
                print("\n👋 Coletor Bac Bo encerrado pelo operador.")
                return
            except Exception as exc:
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
