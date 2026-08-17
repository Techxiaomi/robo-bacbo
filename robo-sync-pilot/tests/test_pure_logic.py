import ast
import pathlib
import queue
import re
import threading
import unittest


ROBO_PATH = pathlib.Path(__file__).resolve().parents[1] / "robo.py"
SOURCE = ROBO_PATH.read_text(encoding="utf-8-sig")
TREE = ast.parse(SOURCE, filename=str(ROBO_PATH))


def carregar_funcoes(nomes, namespace):
    encontrados = {
        node.name: node
        for node in TREE.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in nomes
    }

    faltantes = set(nomes) - set(encontrados)
    if faltantes:
        raise RuntimeError(f"Funcoes nao encontradas em robo.py: {sorted(faltantes)}")

    modulo = ast.Module(
        body=[encontrados[nome] for nome in nomes],
        type_ignores=[]
    )
    ast.fix_missing_locations(modulo)
    exec(compile(modulo, str(ROBO_PATH), "exec"), namespace)
    return namespace


class FakeTime:
    atual = 100.0

    @classmethod
    def time(cls):
        return cls.atual


class FakeResponse:
    def __init__(self, erro=None):
        self.erro = erro
        self.raise_calls = 0

    def raise_for_status(self):
        self.raise_calls += 1
        if self.erro:
            raise self.erro


class FakeRequests:
    chamadas = []
    proxima_resposta = None

    @classmethod
    def reset(cls):
        cls.chamadas = []
        cls.proxima_resposta = None

    @classmethod
    def post(cls, url, **kwargs):
        resposta = cls.proxima_resposta or FakeResponse()
        cls.chamadas.append({
            "url": url,
            "kwargs": kwargs,
            "resposta": resposta
        })
        return resposta


class TestParsearValorMonetario(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ns = {"re": re}
        carregar_funcoes(["parsear_valor_monetario"], ns)
        cls.parsear = staticmethod(ns["parsear_valor_monetario"])

    def test_formato_brasileiro(self):
        self.assertEqual(self.parsear("R$ 1.234,56"), 1234.56)
        self.assertEqual(self.parsear("R$ 15,00"), 15.00)
        self.assertEqual(self.parsear("1.234"), 1234.00)

    def test_formato_internacional(self):
        self.assertEqual(self.parsear("$ 1,234.56"), 1234.56)
        self.assertEqual(self.parsear("12.5"), 12.50)
        self.assertEqual(self.parsear("1,234"), 1234.00)

    def test_espacos_nbsp_e_zero(self):
        self.assertEqual(self.parsear("R$\xa0 2 345,70"), 2345.70)
        self.assertEqual(self.parsear("Saldo: 0,00"), 0.00)

    def test_valores_invalidos_ou_negativos(self):
        self.assertIsNone(self.parsear(None))
        self.assertIsNone(self.parsear("sem saldo"))
        self.assertIsNone(self.parsear("-10,00"))
        self.assertIsNone(self.parsear("R$ -1.234,56"))


class TestRegistrarOrdemIdempotente(unittest.TestCase):
    def setUp(self):
        ns = {
            "ordens_executor_recebidas": {},
            "ordens_executor_lock": threading.Lock(),
            "ORDEM_ID_LIMITE_MEMORIA": 5000,
            "fila_apostas": queue.Queue(),
        }
        carregar_funcoes(["registrar_ordem_idempotente"], ns)
        self.ns = ns
        self.registrar = ns["registrar_ordem_idempotente"]

    @staticmethod
    def ordem(order_id="123e4567-e89b-42d3-a456-426614174000", alvo="PlayerWon", valor=10):
        return {
            "order_id": order_id,
            "alvo": alvo,
            "valor": valor
        }

    def test_primeira_ordem_entra_na_fila(self):
        status, ordem = self.registrar(self.ordem())
        self.assertEqual(status, "nova")
        self.assertEqual(ordem["valor"], 10.0)
        self.assertEqual(self.ns["fila_apostas"].qsize(), 1)

    def test_repeticao_identica_nao_duplica_fila(self):
        self.registrar(self.ordem())
        status, ordem = self.registrar(self.ordem())

        self.assertEqual(status, "duplicada")
        self.assertEqual(ordem["alvo"], "PlayerWon")
        self.assertEqual(self.ns["fila_apostas"].qsize(), 1)

    def test_mesmo_id_com_payload_diferente_e_conflito(self):
        self.registrar(self.ordem())
        status, _ = self.registrar(self.ordem(alvo="BankerWon"))

        self.assertEqual(status, "conflito")
        self.assertEqual(self.ns["fila_apostas"].qsize(), 1)


class TestProcessarResultado(unittest.TestCase):
    def setUp(self):
        FakeRequests.reset()
        FakeTime.atual = 100.0
        self.logs = []

        ns = {
            "time": FakeTime,
            "requests": FakeRequests,
            "WEBHOOK_JS": "http://127.0.0.1:3000/receber-sinal",
            "INTERNAL_API_TOKEN": "token-teste",
            "ultimo_tempo_rodada": 0,
            "COLETOR_SESSAO": "sessao-teste",
            "coletor_seq": 0,
            "registrar_erro_limitado": lambda chave, mensagem, intervalo_segundos=30: self.logs.append(
                (chave, mensagem, intervalo_segundos)
            ),
        }
        carregar_funcoes(["processar_resultado"], ns)
        self.ns = ns
        self.processar = ns["processar_resultado"]

    @staticmethod
    def dados_resolvidos(resultado="PlayerWon"):
        return {
            "args": {
                "game": {
                    "stage": "Resolved",
                    "result": resultado,
                    "dice": [
                        {"id": 1, "value": 3},
                        {"id": 2, "value": 4},
                        {"id": 3, "value": 5},
                        {"id": 4, "value": 6},
                    ],
                }
            }
        }

    def test_ignora_stage_nao_resolvido(self):
        self.processar({"args": {"game": {"stage": "Betting"}}})
        self.assertEqual(FakeRequests.chamadas, [])
        self.assertEqual(self.ns["ultimo_tempo_rodada"], 0)

    def test_monta_payload_player_sem_interrupcao(self):
        self.processar(self.dados_resolvidos("PlayerWon"))

        self.assertEqual(len(FakeRequests.chamadas), 1)
        chamada = FakeRequests.chamadas[0]
        payload = chamada["kwargs"]["json"]

        self.assertEqual(chamada["url"], "http://127.0.0.1:3000/receber-sinal")
        self.assertEqual(chamada["kwargs"]["headers"], {"X-Internal-Token": "token-teste"})
        self.assertEqual(chamada["kwargs"]["timeout"], 2)
        self.assertEqual(chamada["resposta"].raise_calls, 1)

        self.assertEqual(payload["vencedor"], "PlayerWon")
        self.assertEqual(payload["resultado_bruto"], "PlayerWon")
        self.assertEqual(payload["pontos_jogador"], 8)
        self.assertEqual(payload["pontos_banca"], 10)
        self.assertEqual(payload["dados_jogador"], [3, 5])
        self.assertEqual(payload["dados_banca"], [4, 6])
        self.assertEqual(payload["coletor_sessao"], "sessao-teste")
        self.assertEqual(payload["coletor_seq"], 1)
        self.assertFalse(payload["interrupcao_fluxo"])
        self.assertEqual(payload["timestamp_coleta"], 100000)
        self.assertEqual(self.ns["ultimo_tempo_rodada"], 100.0)

    def test_normaliza_tie_e_detecta_interrupcao_maior_que_60s(self):
        self.ns["ultimo_tempo_rodada"] = 30.0
        FakeTime.atual = 100.5

        self.processar(self.dados_resolvidos("TieWon"))

        payload = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertEqual(payload["vencedor"], "Tie")
        self.assertEqual(payload["resultado_bruto"], "TieWon")
        self.assertTrue(payload["interrupcao_fluxo"])
        self.assertEqual(payload["timestamp_coleta"], 100500)

    def test_exatamente_60s_nao_e_interrupcao(self):
        self.ns["ultimo_tempo_rodada"] = 40.0
        FakeTime.atual = 100.0

        self.processar(self.dados_resolvidos("BankerWon"))

        payload = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertFalse(payload["interrupcao_fluxo"])
        self.assertEqual(payload["vencedor"], "BankerWon")

    def test_erro_http_e_registrado_sem_propagar(self):
        FakeRequests.proxima_resposta = FakeResponse(RuntimeError("HTTP 500"))

        self.processar(self.dados_resolvidos("PlayerWon"))

        self.assertEqual(len(FakeRequests.chamadas), 1)
        self.assertEqual(len(self.logs), 1)
        chave, mensagem, intervalo = self.logs[0]
        self.assertEqual(chave, "resultado_node")
        self.assertIn("HTTP 500", mensagem)
        self.assertEqual(intervalo, 30)


    def test_falha_de_post_consume_seq_e_deixa_salto_observavel(self):
        FakeRequests.proxima_resposta = FakeResponse(RuntimeError("HTTP 500"))
        self.processar(self.dados_resolvidos("PlayerWon"))

        primeiro = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertEqual(primeiro["coletor_seq"], 1)
        self.assertEqual(self.ns["coletor_seq"], 1)

        FakeRequests.proxima_resposta = FakeResponse()
        FakeTime.atual = 120.0
        self.processar(self.dados_resolvidos("BankerWon"))

        segundo = FakeRequests.chamadas[1]["kwargs"]["json"]
        self.assertEqual(segundo["coletor_sessao"], "sessao-teste")
        self.assertEqual(segundo["coletor_seq"], 2)
        self.assertEqual(self.ns["coletor_seq"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
