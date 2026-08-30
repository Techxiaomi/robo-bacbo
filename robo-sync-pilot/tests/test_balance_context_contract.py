import ast
import unittest
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo.py"


def fonte():
    return ROBO.read_text(encoding="utf-8")


def arvore():
    return ast.parse(
        fonte(),
        filename=str(ROBO),
    )


def funcao(nome):
    for no in arvore().body:
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


def carregar_dispatch_real():
    tree = arvore()

    nomes = {
        "_rota_url",
        "pagina_na_rota_da_mesa",
        "pagina_na_rota_home",
        "ler_saldo_atual",
    }

    corpo = [
        no
        for no in tree.body
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
            f"Funcoes faltantes: {sorted(nomes - encontrados)}"
        )

    modulo = ast.Module(
        body=corpo,
        type_ignores=[],
    )

    ast.fix_missing_locations(
        modulo
    )

    namespace = {
        "urlparse": urlparse,
        "URL_CASSINO": "https://cassino.local/game/bacbo",
        "URL_HOME_CASSINO": "https://cassino.local/",
        "erro_driver_playwright": lambda _e: False,
    }

    exec(
        compile(
            modulo,
            str(ROBO),
            "exec",
        ),
        namespace,
    )

    return namespace


class PageFake:
    def __init__(self, url):
        self.url = url


class BalanceContextContractTests(
    unittest.TestCase
):

    def test_dispatch_mesa_jamais_chama_home(self):
        ns = carregar_dispatch_real()

        chamadas = []

        ns["ler_saldo_mesa"] = (
            lambda _page, aguardar_ms=0:
            chamadas.append(
                ("MESA", aguardar_ms)
            )
            or 321.45
        )

        ns["ler_saldo_home"] = (
            lambda _page, aguardar_ms=0:
            chamadas.append(
                ("HOME", aguardar_ms)
            )
            or 999999.99
        )

        saldo = ns["ler_saldo_atual"](
            PageFake(
                "https://cassino.local/game/bacbo?table=1"
            ),
            aguardar_ms=5000,
        )

        self.assertEqual(
            saldo,
            321.45,
        )

        self.assertEqual(
            chamadas,
            [
                ("MESA", 5000)
            ],
        )

    def test_dispatch_home_jamais_chama_mesa(self):
        ns = carregar_dispatch_real()

        chamadas = []

        ns["ler_saldo_mesa"] = (
            lambda _page, aguardar_ms=0:
            chamadas.append(
                ("MESA", aguardar_ms)
            )
            or 111.11
        )

        ns["ler_saldo_home"] = (
            lambda _page, aguardar_ms=0:
            chamadas.append(
                ("HOME", aguardar_ms)
            )
            or 654.32
        )

        saldo = ns["ler_saldo_atual"](
            PageFake(
                "https://cassino.local/"
            ),
            aguardar_ms=2500,
        )

        self.assertEqual(
            saldo,
            654.32,
        )

        self.assertEqual(
            chamadas,
            [
                ("HOME", 2500)
            ],
        )

    def test_contexto_desconhecido_nao_aceita_saldo(self):
        ns = carregar_dispatch_real()

        chamadas = []

        ns["ler_saldo_mesa"] = (
            lambda *_args, **_kwargs:
            chamadas.append("MESA")
            or 1.0
        )

        ns["ler_saldo_home"] = (
            lambda *_args, **_kwargs:
            chamadas.append("HOME")
            or 2.0
        )

        saldo = ns["ler_saldo_atual"](
            PageFake(
                "about:blank"
            )
        )

        self.assertIsNone(
            saldo
        )

        self.assertEqual(
            chamadas,
            [],
        )

    def test_home_nao_percorre_frames(self):
        corpo = ast.unparse(
            funcao(
                "ler_saldo_home"
            )
        )

        self.assertIn(
            "pagina_na_rota_home(page)",
            corpo,
        )

        self.assertNotIn(
            "page.frames",
            corpo,
        )

        self.assertIn(
            "_ler_saldo_home_principal(page)",
            corpo,
        )

        self.assertNotIn(
            "_ler_saldo_contexto(page)",
            corpo,
        )

    def test_mesa_nao_usa_main_frame_como_saldo(self):
        corpo = ast.unparse(
            funcao(
                "localizar_frame_saldo_mesa"
            )
        )

        self.assertIn(
            "frame == frame_principal",
            corpo,
        )

        self.assertIn(
            "continue",
            corpo,
        )

        self.assertNotIn(
            "_ler_saldo_contexto(page)",
            corpo,
        )

    def test_gate_aposta_nao_depende_do_seletor_saldo(self):
        corpo = ast.unparse(
            funcao(
                "aguardar_janela_apostas_aberta"
            )
        )

        self.assertIn(
            "localizar_frame_aposta(page, planos)",
            corpo,
        )

        self.assertNotIn(
            "localizar_frame_saldo_mesa(page)",
            corpo,
        )

        frame_aposta = ast.unparse(
            funcao(
                "localizar_frame_aposta"
            )
        )

        self.assertNotIn(
            "CASINO_BALANCE_SELECTOR",
            frame_aposta,
        )

        self.assertNotIn(
            "localizar_frame_saldo_mesa",
            frame_aposta,
        )

    def test_sync_balance_respeita_contexto(self):
        processar = funcao(
            "processar_comando_playwright"
        )

        sync_if = None

        for no in processar.body:
            if not isinstance(
                no,
                ast.If,
            ):
                continue

            teste = ast.unparse(
                no.test
            )

            if (
                "acao" in teste
                and "sync_balance" in teste
            ):
                sync_if = no
                break

        self.assertIsNotNone(
            sync_if
        )

        rota_if = None

        for no in sync_if.body:
            if (
                isinstance(
                    no,
                    ast.If,
                )
                and "pagina_na_rota_da_mesa(page)"
                in ast.unparse(no.test)
            ):
                rota_if = no
                break

        self.assertIsNotNone(
            rota_if
        )

        bloco_mesa = ast.unparse(
            ast.Module(
                body=rota_if.body,
                type_ignores=[],
            )
        )

        self.assertIn(
            "ler_saldo_mesa",
            bloco_mesa,
        )

        self.assertNotIn(
            "ler_saldo_home",
            bloco_mesa,
        )

        bloco_total = ast.unparse(
            sync_if
        )

        self.assertIn(
            "ler_saldo_home",
            bloco_total,
        )

        self.assertIn(
            "ler_saldo_mesa",
            bloco_total,
        )

        self.assertIn(
            "SALDO_MESA_INDISPONIVEL",
            bloco_total,
        )

    def test_home_nao_usa_seletor_da_evolution(self):
        corpo = ast.unparse(
            funcao(
                "ler_saldo_home"
            )
        )

        self.assertIn(
            "_ler_saldo_home_principal(page)",
            corpo,
        )

        self.assertNotIn(
            "_ler_saldo_contexto(page)",
            corpo,
        )

        self.assertNotIn(
            "page.frames",
            corpo,
        )

    def test_home_exige_unico_candidato_monetario(self):
        corpo = ast.unparse(
            funcao(
                "_ler_saldo_home_principal"
            )
        )

        self.assertIn(
            "button[type='button']",
            corpo,
        )

        self.assertIn(
            "span.inline-flex.items-center.gap-2",
            corpo,
        )

        self.assertIn(
            "len(saldos_validos) != 1",
            corpo,
        )

    def test_regex_home_e_exclusiva_para_real_brasileiro(self):
        corpo = ast.unparse(
            funcao(
                "_texto_saldo_home_valido"
            )
        )

        self.assertIn(
            "re.fullmatch",
            corpo,
        )

        self.assertIn(
            "parsear_valor_monetario",
            corpo,
        )


if __name__ == "__main__":
    unittest.main()
