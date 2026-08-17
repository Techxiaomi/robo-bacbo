import ast
import hmac
import json
import os
import pathlib
import queue
import re
import tempfile
import threading
import time

from flask import Flask, jsonify, request


ROBO_PATH = pathlib.Path(__file__).resolve().parents[1] / "robo.py"
SOURCE = ROBO_PATH.read_text(encoding="utf-8-sig")
TREE = ast.parse(SOURCE, filename=str(ROBO_PATH))

FUNCOES = [
    "requisicao_interna_autorizada",
    "persistir_ordens_executor",
    "carregar_ordens_executor_persistidas",
    "registrar_ordem_idempotente",
    "receber_aposta",
]

TOKEN = "bug001r-test-token-123456"
ORDER_1 = "123e4567-e89b-42d3-a456-426614174000"
ORDER_2 = "223e4567-e89b-42d3-a456-426614174001"


def carregar_funcoes(namespace):
    encontrados = {
        node.name: node
        for node in TREE.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in FUNCOES
    }
    faltantes = set(FUNCOES) - set(encontrados)
    if faltantes:
        raise RuntimeError(f"Funcoes nao encontradas em robo.py: {sorted(faltantes)}")

    modulo = ast.Module(body=[encontrados[nome] for nome in FUNCOES], type_ignores=[])
    ast.fix_missing_locations(modulo)
    exec(compile(modulo, str(ROBO_PATH), "exec"), namespace)


def criar_runtime(journal_path, pronto=True):
    app = Flask(f"bug001r-{id(journal_path)}-{os.urandom(4).hex()}")
    executor_pronto = threading.Event()
    if pronto:
        executor_pronto.set()
    namespace = {
        "app": app,
        "request": request,
        "jsonify": jsonify,
        "hmac": hmac,
        "json": json,
        "os": os,
        "re": re,
        "threading": threading,
        "time": time,
        "queue": queue,
        "INTERNAL_API_TOKEN": TOKEN,
        "EXECUTOR_ORDER_JOURNAL_FILE": str(journal_path),
        "ORDEM_ID_LIMITE_MEMORIA": 5000,
        "ordens_executor_recebidas": {},
        "ordens_executor_lock": threading.Lock(),
        "executor_pronto": executor_pronto,
        "fila_apostas": queue.Queue(),
    }
    carregar_funcoes(namespace)
    carregadas = namespace["carregar_ordens_executor_persistidas"]()
    return app, namespace, carregadas


def postar(client, order_id, alvo="PlayerWon", valor=10):
    return client.post(
        "/apostar",
        headers={"X-Internal-Token": TOKEN},
        json={"order_id": order_id, "alvo": alvo, "valor": valor},
    )


def assert_status(response, esperado):
    if response.status_code != esperado:
        raise AssertionError(
            f"HTTP {response.status_code} != {esperado}: {response.get_data(as_text=True)}"
        )


def main():
    with tempfile.TemporaryDirectory() as temp_dir:
        journal = pathlib.Path(temp_dir) / "executor-order-ids.json"

        app1, ns1, carregadas1 = criar_runtime(journal, pronto=True)
        assert carregadas1 == 0
        with app1.test_client() as client1:
            primeira = postar(client1, ORDER_1)
            assert_status(primeira, 200)
            corpo = primeira.get_json()
            assert corpo["aceita"] is True
            assert corpo["duplicada"] is False
            assert corpo["dados"]["order_id"] == ORDER_1
            assert ns1["fila_apostas"].qsize() == 1

        assert journal.is_file()
        payload = json.loads(journal.read_text(encoding="utf-8"))
        assert payload["version"] == 1
        assert len(payload["orders"]) == 1
        assert payload["orders"][0]["order_id"] == ORDER_1

        # Restart indisponível: ID já aceito segue idempotente, mas ID novo é recusado sem persistir/fila.
        app2, ns2, carregadas2 = criar_runtime(journal, pronto=False)
        assert carregadas2 == 1
        assert ns2["fila_apostas"].qsize() == 0

        with app2.test_client() as client2:
            duplicada = postar(client2, ORDER_1)
            assert_status(duplicada, 200)
            corpo_dup = duplicada.get_json()
            assert corpo_dup["aceita"] is True
            assert corpo_dup["duplicada"] is True
            assert ns2["fila_apostas"].qsize() == 0

            indisponivel = postar(client2, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(indisponivel, 503)
            corpo_ind = indisponivel.get_json()
            assert corpo_ind["aceita"] is False
            assert ns2["fila_apostas"].qsize() == 0
            payload_sem_nova = json.loads(journal.read_text(encoding="utf-8"))
            assert len(payload_sem_nova["orders"]) == 1

            ns2["executor_pronto"].set()
            nova = postar(client2, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(nova, 200)
            assert nova.get_json()["aceita"] is True
            assert nova.get_json()["duplicada"] is False
            assert ns2["fila_apostas"].qsize() == 1

            conflito = postar(client2, ORDER_2, alvo="PlayerWon", valor=25)
            assert_status(conflito, 409)
            assert ns2["fila_apostas"].qsize() == 1

        app3, ns3, carregadas3 = criar_runtime(journal, pronto=True)
        assert carregadas3 == 2
        with app3.test_client() as client3:
            duplicada2 = postar(client3, ORDER_2, alvo="BankerWon", valor=25)
            assert_status(duplicada2, 200)
            assert duplicada2.get_json()["duplicada"] is True
            assert ns3["fila_apostas"].qsize() == 0

        journal.write_text("{arquivo-corrompido", encoding="utf-8")
        try:
            criar_runtime(journal)
        except RuntimeError as exc:
            assert "journal" in str(exc).lower()
        else:
            raise AssertionError("Journal corrompido deveria falhar fechado")

    print("BUG-001R/014B executor readiness + restart integration: PASS")


if __name__ == "__main__":
    main()
