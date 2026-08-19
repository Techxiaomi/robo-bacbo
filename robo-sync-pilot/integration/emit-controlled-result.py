#!/usr/bin/env python3
import argparse
import ast
import json as json_module
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


class ResponseCompat:
    def __init__(self, status, body):
        self.status_code = int(status)
        self.body = body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}: {self.body}")


class RequestsCompat:
    @staticmethod
    def post(url, json=None, headers=None, timeout=2):
        data = json_module.dumps(json or {}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                **(headers or {}),
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return ResponseCompat(
                    response.status,
                    response.read().decode("utf-8", errors="replace"),
                )
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            return ResponseCompat(error.code, body)


def extract_functions(source_path, function_names):
    source = source_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(source_path))
    by_name = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in function_names
    }
    missing = [name for name in function_names if name not in by_name]
    if missing:
        raise RuntimeError(
            f"Funções {missing} não encontradas em {source_path}"
        )

    module = ast.Module(
        body=[by_name[name] for name in function_names],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    return compile(module, str(source_path), "exec")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--seq", type=int, required=True)
    parser.add_argument(
        "--winner",
        choices=["PlayerWon", "BankerWon", "Tie"],
        required=True,
    )
    parser.add_argument("--p1", type=int, required=True)
    parser.add_argument("--p2", type=int, required=True)
    parser.add_argument("--b1", type=int, required=True)
    parser.add_argument("--b2", type=int, required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.seq <= 0:
        raise RuntimeError("--seq deve ser maior que zero")

    repo_root = Path(__file__).resolve().parents[2]
    robo_path = repo_root / "robo-sync-pilot" / "robo.py"

    def registrar_erro_limitado(chave, mensagem, intervalo_segundos=30):
        raise RuntimeError(f"{chave}: {mensagem}")

    namespace = {
        "time": time,
        "requests": RequestsCompat,
        "WEBHOOK_JS": args.node_url,
        "INTERNAL_API_TOKEN": args.token,
        "COLETOR_SESSAO": args.session,
        "ultimo_tempo_rodada": 0,
        "coletor_seq": args.seq - 1,
        "ultimo_resultado_chave": None,
        "ultimo_resultado_chave_em": 0.0,
        "historico_resultados_confirmados_lock": threading.Lock(),
        "historico_resultados_confirmados": [],
        "HISTORICO_RESULTADOS_CONFIRMADOS_LIMITE": 12,
        "RESULT_DEDUP_WINDOW_SECONDS": 3.0,
        "executor_pronto": threading.Event(),
        "continuidade_fluxo_lock": threading.Lock(),
        "continuidade_fluxo": {
            "interrompida": False,
            "motivo": "",
            "geracao": 0,
        },
        "notificar_interrupcao_node": lambda motivo, timestamp_ms=None: True,
        "registrar_erro_limitado": registrar_erro_limitado,
    }

    exec(
        extract_functions(
            robo_path,
            [
                "chave_resultado_resolvido",
                "identidade_rodada_evolution",
                "marcador_resultado",
                "registrar_resultado_confirmado",
                "resultado_resolvido_duplicado",
                "marcar_interrupcao_fluxo",
                "snapshot_interrupcao_fluxo",
                "id_interrupcao_fluxo",
                "confirmar_interrupcao_reportada",
                "validar_resultado_resolvido",
                "processar_resultado",
            ],
        ),
        namespace,
    )

    payload = {
        "args": {
            "game": {
                "stage": "Resolved",
                "result": args.winner,
                "dice": [
                    {"id": 1, "value": args.p1},
                    {"id": 2, "value": args.b1},
                    {"id": 3, "value": args.p2},
                    {"id": 4, "value": args.b2},
                ],
            }
        }
    }

    namespace["processar_resultado"](payload)

    emitted_seq = int(namespace["coletor_seq"])
    if emitted_seq != args.seq:
        raise RuntimeError(
            f"Sequência emitida divergente: esperado={args.seq} recebido={emitted_seq}"
        )

    print(
        f"CONTROLLED_RESULT_SENT session={args.session} "
        f"seq={emitted_seq} winner={args.winner}"
    )


if __name__ == "__main__":
    main()
