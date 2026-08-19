import ast
import json
import os
import pathlib
import queue
import re
import tempfile
import threading
import time
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
    FUNCOES = [
        "normalizar_apostas_recebidas",
        "persistir_ordens_executor",
        "carregar_ordens_executor_persistidas",
        "registrar_ordem_idempotente",
        "ordem_executor_expirada",
    ]

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.journal = os.path.join(self.temp_dir.name, "executor-order-ids.json")
        self.ns = self.criar_namespace()
        self.registrar = self.ns["registrar_ordem_idempotente"]

    def tearDown(self):
        self.temp_dir.cleanup()

    def criar_namespace(self):
        ns = {
            "json": json,
            "os": os,
            "re": re,
            "threading": threading,
            "time": time,
            "ordens_executor_recebidas": {},
            "ordens_executor_lock": threading.Lock(),
            "ORDEM_ID_LIMITE_MEMORIA": 5000,
            "EXECUTOR_ORDER_TTL_SECONDS": 8.0,
            "EXECUTOR_ORDER_JOURNAL_FILE": self.journal,
            "fila_apostas": queue.Queue(),
        }
        carregar_funcoes(self.FUNCOES, ns)
        return ns

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
        enfileirada = self.ns["fila_apostas"].queue[0]
        self.assertGreater(enfileirada["aceita_em_ms"], 0)
        self.assertTrue(enfileirada["sincronizar_janela"])
        self.assertEqual(enfileirada["coletor_seq_aceite"], 0)
        self.assertTrue(os.path.isfile(self.journal))

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

    def test_reinicio_carrega_id_e_nao_reenfileira(self):
        self.registrar(self.ordem())

        ns_reiniciado = self.criar_namespace()
        carregadas = ns_reiniciado["carregar_ordens_executor_persistidas"]()
        self.assertEqual(carregadas, 1)
        self.assertEqual(ns_reiniciado["fila_apostas"].qsize(), 0)

        status, ordem = ns_reiniciado["registrar_ordem_idempotente"](self.ordem())
        self.assertEqual(status, "duplicada")
        self.assertEqual(ordem["order_id"], self.ordem()["order_id"])
        self.assertEqual(ns_reiniciado["fila_apostas"].qsize(), 0)

    def test_journal_corrompido_falha_fechado(self):
        with open(self.journal, "w", encoding="utf-8") as arquivo:
            arquivo.write("{corrompido")

        ns_reiniciado = self.criar_namespace()
        with self.assertRaisesRegex(RuntimeError, "(?i)journal"):
            ns_reiniciado["carregar_ordens_executor_persistidas"]()

    def test_ttl_considera_ordem_velha_expirada_e_timestamp_ausente_inseguro(self):
        expirada = self.ns["ordem_executor_expirada"]
        ordem = {"aceita_em_ms": 1000}
        self.assertFalse(expirada(ordem, agora_ms=9000))
        self.assertTrue(expirada(ordem, agora_ms=9001))
        self.assertTrue(expirada({}, agora_ms=1000))


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
            "executor_pronto": threading.Event(),
            "ultimo_tempo_rodada": 0,
            "COLETOR_SESSAO": "sessao-teste",
            "coletor_seq": 0,
            "ultimo_resultado_chave": None,
            "ultimo_resultado_chave_em": 0.0,
            "RESULT_DEDUP_WINDOW_SECONDS": 3.0,
            "continuidade_fluxo_lock": threading.Lock(),
            "continuidade_fluxo": {
                "interrompida": False,
                "motivo": "",
                "geracao": 0,
            },
            "notificar_interrupcao_node": lambda motivo, timestamp_ms=None: True,
            "registrar_erro_limitado": lambda chave, mensagem, intervalo_segundos=30: self.logs.append(
                (chave, mensagem, intervalo_segundos)
            ),
        }
        carregar_funcoes([
            "chave_resultado_resolvido",
            "identidade_rodada_evolution",
            "resultado_resolvido_duplicado",
            "marcar_interrupcao_fluxo",
            "snapshot_interrupcao_fluxo",
            "id_interrupcao_fluxo",
            "confirmar_interrupcao_reportada",
            "validar_resultado_resolvido",
            "processar_resultado",
        ], ns)
        self.ns = ns
        self.processar = ns["processar_resultado"]

    @staticmethod
    def dados_resolvidos(resultado="PlayerWon"):
        valores = {
            "PlayerWon": [3, 2, 5, 4],
            "BankerWon": [3, 4, 5, 6],
            "TieWon": [3, 4, 5, 4],
        }.get(resultado, [3, 2, 5, 4])
        return {
            "args": {
                "game": {
                    "stage": "Resolved",
                    "result": resultado,
                    "dice": [
                        {"id": 1, "value": valores[0]},
                        {"id": 2, "value": valores[1]},
                        {"id": 3, "value": valores[2]},
                        {"id": 4, "value": valores[3]},
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
        self.assertEqual(payload["pontos_banca"], 6)
        self.assertEqual(payload["dados_jogador"], [3, 5])
        self.assertEqual(payload["dados_banca"], [2, 4])
        self.assertEqual(payload["coletor_sessao"], "sessao-teste")
        self.assertEqual(payload["coletor_seq"], 1)
        self.assertEqual(payload["rodada_origem"], "")
        self.assertFalse(payload["interrupcao_fluxo"])
        self.assertEqual(payload["motivo_interrupcao"], "")
        self.assertEqual(payload["timestamp_coleta"], 100000)
        self.assertEqual(self.ns["ultimo_tempo_rodada"], 100.0)

    def test_normaliza_tie_e_trata_intervalo_maior_que_60s_apenas_como_aviso(self):
        self.ns["ultimo_tempo_rodada"] = 30.0
        FakeTime.atual = 100.5

        self.processar(self.dados_resolvidos("TieWon"))

        payload = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertEqual(payload["vencedor"], "Tie")
        self.assertEqual(payload["resultado_bruto"], "TieWon")
        self.assertFalse(payload["interrupcao_fluxo"])
        self.assertEqual(payload["motivo_interrupcao"], "")
        self.assertEqual(payload["timestamp_coleta"], 100500)
        self.assertTrue(any(
            chave == "intervalo_resultados_longo" and "continuidade preservada" in mensagem
            for chave, mensagem, _ in self.logs
        ))

    def test_exatamente_60s_nao_e_interrupcao(self):
        self.ns["ultimo_tempo_rodada"] = 40.0
        FakeTime.atual = 100.0

        self.processar(self.dados_resolvidos("BankerWon"))

        payload = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertFalse(payload["interrupcao_fluxo"])
        self.assertEqual(payload["vencedor"], "BankerWon")
        self.assertFalse(any(chave == "intervalo_resultados_longo" for chave, _, _ in self.logs))

    def test_frame_resolved_identico_repetido_nao_consume_nova_seq(self):
        dados = self.dados_resolvidos("PlayerWon")
        self.processar(dados)
        FakeTime.atual = 101.0
        self.processar(dados)

        self.assertEqual(len(FakeRequests.chamadas), 1)
        self.assertEqual(self.ns["coletor_seq"], 1)
        self.assertTrue(any(chave == "resultado_resolved_duplicado" for chave, _, _ in self.logs))

    def test_fingerprint_igual_depois_da_janela_e_nova_rodada(self):
        dados = self.dados_resolvidos("BankerWon")
        self.processar(dados)
        FakeTime.atual = 103.001
        self.processar(dados)

        self.assertEqual(len(FakeRequests.chamadas), 2)
        self.assertEqual(FakeRequests.chamadas[0]["kwargs"]["json"]["coletor_seq"], 1)
        self.assertEqual(FakeRequests.chamadas[1]["kwargs"]["json"]["coletor_seq"], 2)

    def test_fingerprint_repetido_continuamente_renova_janela(self):
        dados = self.dados_resolvidos("PlayerWon")
        self.processar(dados)
        for instante in (102.0, 104.0, 106.0):
            FakeTime.atual = instante
            self.processar(dados)

        self.assertEqual(len(FakeRequests.chamadas), 1)
        self.assertEqual(self.ns["coletor_seq"], 1)

        FakeTime.atual = 109.001
        self.processar(dados)
        self.assertEqual(len(FakeRequests.chamadas), 2)
        self.assertEqual(self.ns["coletor_seq"], 2)

    def test_round_id_repetido_e_ignorado_mesmo_fora_da_janela(self):
        dados = self.dados_resolvidos("PlayerWon")
        dados["args"]["game"]["roundId"] = "round-123"
        self.processar(dados)
        FakeTime.atual = 120.0
        self.processar(dados)

        self.assertEqual(len(FakeRequests.chamadas), 1)
        self.assertEqual(self.ns["coletor_seq"], 1)

    def test_round_id_novo_processa_mesmo_com_mesmo_resultado_e_dados(self):
        primeiro = self.dados_resolvidos("PlayerWon")
        primeiro["args"]["game"]["round_id"] = "r1"
        segundo = self.dados_resolvidos("PlayerWon")
        segundo["args"]["game"]["round_id"] = "r2"
        self.processar(primeiro)
        FakeTime.atual = 100.1
        self.processar(segundo)

        self.assertEqual(len(FakeRequests.chamadas), 2)
        self.assertEqual(self.ns["coletor_seq"], 2)

    def test_erro_http_e_registrado_sem_propagar(self):
        FakeRequests.proxima_resposta = FakeResponse(RuntimeError("HTTP 500"))

        self.processar(self.dados_resolvidos("PlayerWon"))

        self.assertEqual(len(FakeRequests.chamadas), 1)
        self.assertEqual(len(self.logs), 1)
        chave, mensagem, intervalo = self.logs[0]
        self.assertEqual(chave, "resultado_node")
        self.assertIn("HTTP 500", mensagem)
        self.assertEqual(intervalo, 30)
        self.assertTrue(self.ns["continuidade_fluxo"]["interrompida"])

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
        self.assertTrue(segundo["interrupcao_fluxo"])
        self.assertEqual(segundo["motivo_interrupcao"], "FALHA_ENVIO_RESULTADO_NODE")
        self.assertEqual(self.ns["coletor_seq"], 2)

    def test_lacre_de_interrupcao_invalida_proximo_resultado_e_so_limpa_apos_ack(self):
        self.assertTrue(self.ns["marcar_interrupcao_fluxo"]("PLAYER_STATE_STALE"))

        self.processar(self.dados_resolvidos("PlayerWon"))

        payload = FakeRequests.chamadas[0]["kwargs"]["json"]
        self.assertTrue(payload["interrupcao_fluxo"])
        self.assertEqual(payload["motivo_interrupcao"], "PLAYER_STATE_STALE")
        self.assertEqual(payload["interrupcao_id"], "sessao-teste:1")
        self.assertEqual(payload["interrupcao_geracao"], 1)
        self.assertFalse(self.ns["continuidade_fluxo"]["interrompida"])

    def test_nova_interrupcao_nao_e_apagada_por_ack_de_snapshot_anterior(self):
        self.ns["marcar_interrupcao_fluxo"]("WEBSOCKET_PLAYER_STATE_FECHADO")
        snapshot = self.ns["snapshot_interrupcao_fluxo"]()
        self.ns["marcar_interrupcao_fluxo"]("PLAYER_STATE_STALE")

        self.assertFalse(self.ns["confirmar_interrupcao_reportada"](snapshot["geracao"]))
        atual = self.ns["snapshot_interrupcao_fluxo"]()
        self.assertTrue(atual["interrompida"])
        self.assertEqual(atual["motivo"], "PLAYER_STATE_STALE")

    def test_resultado_incompleto_e_rejeitado_sem_consumir_sequencia(self):
        dados = self.dados_resolvidos("PlayerWon")
        dados["args"]["game"]["dice"] = dados["args"]["game"]["dice"][:3]

        self.processar(dados)

        self.assertEqual(FakeRequests.chamadas, [])
        self.assertEqual(self.ns["coletor_seq"], 0)
        self.assertTrue(self.ns["continuidade_fluxo"]["interrompida"])
        self.assertTrue(any(chave == "resultado_resolved_invalido" for chave, _, _ in self.logs))

    def test_resultado_rejeita_dado_duplicado_fora_de_faixa_e_vencedor_desconhecido(self):
        casos = []
        duplicado = self.dados_resolvidos()
        duplicado["args"]["game"]["dice"][3]["id"] = 3
        casos.append(duplicado)

        fora_faixa = self.dados_resolvidos()
        fora_faixa["args"]["game"]["dice"][0]["value"] = 7
        casos.append(fora_faixa)

        vencedor_invalido = self.dados_resolvidos("Unknown")
        casos.append(vencedor_invalido)

        for dados in casos:
            with self.subTest(dados=dados):
                with self.assertRaises(ValueError):
                    self.ns["validar_resultado_resolvido"](dados["args"]["game"])

        vencedor_incoerente = self.dados_resolvidos("PlayerWon")
        vencedor_incoerente["args"]["game"]["dice"] = [
            {"id": 1, "value": 1}, {"id": 2, "value": 6},
            {"id": 3, "value": 1}, {"id": 4, "value": 6},
        ]
        with self.assertRaisesRegex(ValueError, "incompatível"):
            self.ns["validar_resultado_resolvido"](vencedor_incoerente["args"]["game"])


class TestEstadoRodadaEvolution(unittest.TestCase):
    def setUp(self):
        self.ns = {
            "time": FakeTime,
            "threading": threading,
            "estado_mesa_lock": threading.Lock(),
            "estado_mesa": {
                "stage": "",
                "atualizado_em_ms": 0,
                "round_id": "",
                "round_resolvido": False,
            },
        }
        carregar_funcoes([
            "identidade_rodada_evolution",
            "atualizar_estado_mesa_player",
            "player_state_reconexao_elegivel",
            "classificar_reconexao_player_state",
        ], self.ns)
        self.atualizar = self.ns["atualizar_estado_mesa_player"]
        self.reconexao_elegivel = self.ns["player_state_reconexao_elegivel"]
        self.classificar_reconexao = self.ns["classificar_reconexao_player_state"]

    @staticmethod
    def estado(stage, round_id=None):
        game = {"stage": stage}
        if round_id is not None:
            game["roundId"] = round_id
        return {"args": {"game": game}}

    def test_troca_de_round_sem_resolved_lacra_continuidade(self):
        self.assertEqual(self.atualizar(self.estado("Betting", "100")), "")
        self.assertEqual(
            self.atualizar(self.estado("Betting", "101")),
            "TROCA_RODADA_SEM_RESOLVED",
        )

    def test_round_id_nao_e_assumido_sequencial_sem_contrato_da_evolution(self):
        self.assertEqual(self.atualizar(self.estado("Resolved", "100")), "")
        self.assertEqual(self.atualizar(self.estado("Betting", "102")), "")

    def test_round_seguinte_contiguo_apos_resolved_e_aceito(self):
        self.assertEqual(self.atualizar(self.estado("Resolved", "100")), "")
        self.assertEqual(self.atualizar(self.estado("Betting", "101")), "")

    def test_resolved_sem_repetir_round_id_fecha_round_atual(self):
        self.assertEqual(self.atualizar(self.estado("Betting", "100")), "")
        self.assertEqual(self.atualizar(self.estado("Resolved")), "")
        self.assertEqual(self.atualizar(self.estado("Betting", "101")), "")

    def test_player_state_sem_stage_e_invalido(self):
        self.assertEqual(
            self.atualizar({"args": {"game": {"roundId": "100"}}}),
            "PLAYER_STATE_SEM_STAGE",
        )

    def test_reconexao_aguarda_frame_completo_antes_de_classificar(self):
        self.assertFalse(self.reconexao_elegivel(self.estado("Betting")))
        self.assertFalse(self.reconexao_elegivel({"args": {"game": {"roundId": "100"}}}))
        self.assertTrue(self.reconexao_elegivel(self.estado("Betting", "100")))

    def test_reconexao_na_mesma_rodada_preserva_continuidade(self):
        resultado = self.classificar_reconexao(
            {"round_id": "100", "round_resolvido": False, "stage": "Dealing"},
            self.estado("Dealing", "100"),
            3,
            10,
        )
        self.assertTrue(resultado["segura"])
        self.assertEqual(resultado["motivo"], "MESMA_RODADA")

    def test_reconexao_na_proxima_rodada_so_e_segura_apos_resolved(self):
        segura = self.classificar_reconexao(
            {"round_id": "100", "round_resolvido": True, "stage": "Resolved"},
            self.estado("Betting", "qualquer-id-novo"),
            4,
            10,
        )
        self.assertTrue(segura["segura"])
        self.assertEqual(segura["motivo"], "PROXIMA_RODADA_APOS_RESOLVED")

        insegura = self.classificar_reconexao(
            {"round_id": "100", "round_resolvido": False, "stage": "Dealing"},
            self.estado("Betting", "101"),
            4,
            10,
        )
        self.assertFalse(insegura["segura"])
        self.assertEqual(insegura["motivo"], "TROCA_RODADA_DURANTE_RECONEXAO")

    def test_reconexao_ambigua_ou_fora_da_janela_falha_fechado(self):
        sem_id = self.classificar_reconexao(
            {"round_id": "100", "round_resolvido": True},
            self.estado("Betting"),
            2,
            10,
        )
        self.assertFalse(sem_id["segura"])
        self.assertEqual(sem_id["motivo"], "RECONEXAO_SEM_ROUND_ID")

        tardia = self.classificar_reconexao(
            {"round_id": "100", "round_resolvido": True},
            self.estado("Betting", "101"),
            10.01,
            10,
        )
        self.assertFalse(tardia["segura"])
        self.assertEqual(tardia["motivo"], "RECONEXAO_FORA_DA_JANELA")


class TestContratoWebSocketFailClosed(unittest.TestCase):
    def test_socket_oficial_exige_player_state_e_close_entra_em_quarentena(self):
        self.assertIn('dados.get("type") == "bacbo.playerState"', SOURCE)
        self.assertIn('"ws_oficial": ws', SOURCE)
        self.assertIn('if status_conexao.get("ws_oficial") is not ws:', SOURCE)
        self.assertIn('"reconexao_pendente"', SOURCE)
        self.assertIn('WEBSOCKET_RECONNECT_GRACE_SECONDS', SOURCE)
        self.assertNotIn('marcar_interrupcao_fluxo("WEBSOCKET_PLAYER_STATE_FECHADO")', SOURCE)
        self.assertIn('motivo = "WEBSOCKET_RECONEXAO_TIMEOUT"', SOURCE)
        self.assertIn('not player_state_reconexao_elegivel(dados)', SOURCE)
        self.assertIn('aguardando playerState completo com stage e roundId', SOURCE)

    def test_sessao_saudavel_nao_e_recarregada_por_tempo_fixo(self):
        self.assertIn('while status_conexao["ativa"]:', SOURCE)
        self.assertNotIn('(2 * 60 * 60 * 1000)', SOURCE)
        self.assertNotIn('Reinicia a cada 2 horas', SOURCE)
        self.assertNotIn('tempo_passado += 10000', SOURCE)

    def test_watchdog_reinicia_coletor_e_notifica_node(self):
        self.assertIn("COLLECTOR_PLAYER_STATE_STALE_SECONDS", SOURCE)
        self.assertIn('marcar_interrupcao_fluxo("PLAYER_STATE_STALE")', SOURCE)
        self.assertIn('notificar_interrupcao_node("PLAYER_STATE_STALE")', SOURCE)




class Bug019CompositePayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ns = {}
        carregar_funcoes(["normalizar_apostas_recebidas"], ns)
        cls.normalizar = staticmethod(ns["normalizar_apostas_recebidas"])

    def test_normaliza_ordem_composta_principal_mais_tie(self):
        apostas = self.normalizar({"apostas": [
            {"alvo": "PlayerWon", "valor": 20},
            {"alvo": "Tie", "valor": 5}
        ]})
        self.assertEqual(apostas, [
            {"alvo": "PlayerWon", "valor": 20.0},
            {"alvo": "Tie", "valor": 5.0}
        ])

    def test_rejeita_valor_nao_representavel_e_alvo_duplicado(self):
        with self.assertRaises(ValueError):
            self.normalizar({"apostas": [{"alvo": "PlayerWon", "valor": 7}]})
        with self.assertRaises(ValueError):
            self.normalizar({"apostas": [
                {"alvo": "Tie", "valor": 5}, {"alvo": "Tie", "valor": 10}
            ]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
