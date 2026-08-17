#!/usr/bin/env python3
import argparse
import ast
import json as json_module
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


def extract_function(source_path, function_name):
    source = source_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(source_path))
    function_node = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function_name
        ),
        None,
    )
    if function_node is None:
        raise RuntimeError(f"Função {function_name} não encontrada em {source_path}")

    module = ast.Module(body=[function_node], type_ignores=[])
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
        "registrar_erro_limitado": registrar_erro_limitado,
    }

    exec(extract_function(robo_path, "processar_resultado"), namespace)

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
