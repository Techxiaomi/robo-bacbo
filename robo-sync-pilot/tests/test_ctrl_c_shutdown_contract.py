import ast
import socket
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROBO_PATH = ROOT / "robo.py"
SOURCE = ROBO_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE, filename=str(ROBO_PATH))


def funcao(nome):
    for no in TREE.body:
        if (
            isinstance(
                no,
                (
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                ),
            )
            and no.name == nome
        ):
            return no

    raise AssertionError(
        f"Funcao ausente: {nome}"
    )


def corpo_funcao(nome):
    return ast.unparse(
        funcao(nome)
    )


def carregar_helpers_encerramento():
    nomes = {
        "registrar_socket_listener_redis",
        "limpar_socket_listener_redis",
        "solicitar_encerramento_executor",
    }

    corpo = [
        no
        for no in TREE.body
        if (
            isinstance(
                no,
                ast.FunctionDef,
            )
            and no.name in nomes
        )
    ]

    encontrados = {
        no.name
        for no in corpo
    }

    if encontrados != nomes:
        raise AssertionError(
            f"Helpers faltantes: {sorted(nomes - encontrados)}"
        )

    modulo = ast.Module(
        body=corpo,
        type_ignores=[],
    )

    ast.fix_missing_locations(
        modulo
    )

    namespace = {
        "socket": socket,
        "threading": threading,
        "encerrar_executor": threading.Event(),
        "redis_listener_socket_lock": threading.Lock(),
        "redis_listener_socket": None,
    }

    exec(
        compile(
            modulo,
            str(ROBO_PATH),
            "exec",
        ),
        namespace,
    )

    return namespace


class SocketFake:
    def __init__(self):
        self.shutdowns = []

    def shutdown(self, how):
        self.shutdowns.append(
            how
        )


class CtrlCShutdownContractTests(
    unittest.TestCase
):

    def test_shutdown_sinaliza_evento_e_desbloqueia_socket(self):
        ns = carregar_helpers_encerramento()

        fake = SocketFake()

        ns[
            "registrar_socket_listener_redis"
        ](
            fake
        )

        ns[
            "solicitar_encerramento_executor"
        ]()

        self.assertTrue(
            ns[
                "encerrar_executor"
            ].is_set()
        )

        self.assertEqual(
            fake.shutdowns,
            [
                socket.SHUT_RDWR
            ],
        )

    def test_limpeza_nao_remove_socket_mais_novo(self):
        ns = carregar_helpers_encerramento()

        antigo = SocketFake()
        novo = SocketFake()

        ns[
            "registrar_socket_listener_redis"
        ](
            antigo
        )

        ns[
            "registrar_socket_listener_redis"
        ](
            novo
        )

        ns[
            "limpar_socket_listener_redis"
        ](
            antigo
        )

        self.assertIs(
            ns[
                "redis_listener_socket"
            ],
            novo,
        )

    def test_listener_redis_observa_encerramento(self):
        corpo = corpo_funcao(
            "ouvir_comandos_redis"
        )

        self.assertIn(
            "while not encerrar_executor.is_set()",
            corpo,
        )

        self.assertIn(
            "registrar_socket_listener_redis(sock)",
            corpo,
        )

        self.assertIn(
            "limpar_socket_listener_redis(sock)",
            corpo,
        )

        self.assertIn(
            "encerrar_executor.wait(2.0)",
            corpo,
        )

        self.assertNotIn(
            "time.sleep(2)",
            corpo,
        )

    def test_worker_nao_inicia_nova_tarefa_apos_shutdown(self):
        ciclo = corpo_funcao(
            "ciclo_playwright"
        )

        worker = corpo_funcao(
            "worker_playwright"
        )

        self.assertIn(
            "while not encerrar_executor.is_set()",
            ciclo,
        )

        self.assertIn(
            "if encerrar_executor.is_set():",
            ciclo,
        )

        self.assertIn(
            "while not encerrar_executor.is_set()",
            worker,
        )

    def test_main_nao_bloqueia_diretamente_no_redis(self):
        corpo = corpo_funcao(
            "executar_main"
        )

        self.assertIn(
            "target=ouvir_comandos_redis",
            corpo,
        )

        self.assertIn(
            "target=worker_playwright",
            corpo,
        )

        self.assertIn(
            "except KeyboardInterrupt",
            corpo,
        )

        self.assertIn(
            "solicitar_encerramento_executor()",
            corpo,
        )

        self.assertIn(
            "encerrar_executor.wait(0.5)",
            corpo,
        )

    def test_shutdown_preserva_operacao_financeira_em_curso(self):
        corpo = corpo_funcao(
            "executar_main"
        )

        self.assertIn(
            "auto_trader_operando.is_set()",
            corpo,
        )

        self.assertIn(
            "while auto_trader_operando.is_set()",
            corpo,
        )

        self.assertIn(
            "não será interrompida no meio",
            corpo,
        )


if __name__ == "__main__":
    unittest.main()
