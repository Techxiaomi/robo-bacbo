from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
TEST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

texto = ROBO.read_text(encoding="utf-8")
original = texto


def substituir(antigo, novo, descricao):
    global texto
    quantidade = texto.count(antigo)
    if quantidade != 1:
        raise SystemExit(f"BUG-038: esperado 1 match para {descricao}, encontrado {quantidade}")
    texto = texto.replace(antigo, novo, 1)


substituir(
    'VERSAO_ROBO = "v1.6.11"\nNOME_ATUALIZACAO = "Aceite Financeiro Evolution Fail-Closed"',
    'VERSAO_ROBO = "v1.6.12"\nNOME_ATUALIZACAO = "BUG-038 Fast Path da Janela Evolution"',
    "versao",
)

substituir(
    '        hit_elemento.click(timeout=2000)\n        return {"acionada": True, "relacao": relacao, "via": "PLAYWRIGHT_REAL"}\n    except PlaywrightTimeoutError:\n        return {"acionada": False, "relacao": "TIMEOUT", "motivo": "superfície não ficou acionável em 2s"}',
    '        hit_elemento.click(timeout=700)\n        return {"acionada": True, "relacao": relacao, "via": "PLAYWRIGHT_REAL"}\n    except PlaywrightTimeoutError:\n        return {"acionada": False, "relacao": "TIMEOUT", "motivo": "superfície não ficou acionável em 700ms"}',
    "timeout superficie ficha",
)

substituir(
    '    try:\n        elemento.click(timeout=2000)\n        return {"confirmada": True, "via": "PLAYWRIGHT"}\n',
    '    try:\n        elemento.click(timeout=700)\n        return {"confirmada": True, "via": "PLAYWRIGHT"}\n',
    "timeout selecao ficha",
)

substituir(
    '    # A conclusão do clique Playwright é a mesma evidência operacional aceita\n    # no caminho direto que já funcionava manualmente. O clique ainda é\n    # estritamente não financeiro; stage/seq são revalidados antes do alvo.\n    page.wait_for_timeout(120)\n',
    '    # Selecionar a ficha não cria exposição financeira. Não há sleep artificial\n    # aqui: o caminho crítico deve chegar ao alvo enquanto AcceptingBets ainda está\n    # vigente; stage/seq continuam revalidados imediatamente antes do clique financeiro.\n',
    "remover sleep da selecao",
)

helper = '''\n\ndef preselecionar_ficha_unica_antes_da_janela(page, planos):
    """Tenta preparar uma única denominação antes da janela; nunca clica alvo financeiro."""
    fichas = sorted({
        int(ficha)
        for plano in (planos or [])
        for ficha, _ in plano.get("cliques_necessarios", [])
    })
    if len(fichas) != 1:
        return {"confirmada": False, "ficha": None, "motivo": "PLANO_MULTIFICHAS"}

    ficha = fichas[0]
    for frame in list(getattr(page, "frames", []) or []):
        ficha_contexto, _, _ = localizar_ficha_apostavel(frame, ficha)
        if ficha_contexto is None:
            continue
        if ficha_contexto.get("modo") == "JA_SELECIONADA":
            return {"confirmada": True, "ficha": ficha, "via": "JA_SELECIONADA"}

        elemento = ficha_contexto.get("elemento")
        if elemento is None:
            continue
        try:
            # Preparação não financeira e oportunista. Falha aqui não invalida a
            # ordem; o caminho normal ainda pode selecionar a ficha em AcceptingBets.
            elemento.click(timeout=300)
            return {"confirmada": True, "ficha": ficha, "via": "PRESELECAO_PLAYWRIGHT"}
        except Exception:
            continue

    return {"confirmada": False, "ficha": ficha, "motivo": "PRESELECAO_INDISPONIVEL"}
'''
substituir(
    '\n\ndef formatar_diagnostico_janela(contexto, diagnostico):',
    helper + '\n\ndef formatar_diagnostico_janela(contexto, diagnostico):',
    "inserir helper preselecionar ficha",
)

substituir(
    'def aguardar_janela_aposta(page, aposta, planos):\n    sincronizar = aposta.get("sincronizar_janela") is True\n    prazo = time.monotonic() + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS',
    'def aguardar_janela_aposta(page, aposta, planos):\n    sincronizar = aposta.get("sincronizar_janela") is True\n    inicio_espera = time.monotonic()\n    prazo = inicio_espera + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS',
    "inicio espera janela",
)

substituir(
    '            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            if contexto_dom is not None:\n                return contexto_dom, None',
    '            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            if contexto_dom is not None:\n                if sincronizar:\n                    print(\n                        f"⚡ Ordem {aposta.get(\'order_id\', \'n/a\')}: DOM pronto em "\n                        f"{(time.monotonic() - inicio_espera) * 1000:.0f}ms; iniciando fast path financeiro."\n                    )\n                return contexto_dom, None',
    "telemetria janela pronta",
)

substituir(
    '        page.wait_for_timeout(100)\n\n\ndef confirmar_aceite_financeiro_aposta',
    '        page.wait_for_timeout(25)\n\n\ndef confirmar_aceite_financeiro_aposta',
    "poll janela",
)

antigo_fluxo = '''        # BUG-019: principal e proteção Tie precisam estar acionáveis antes do primeiro clique real.
        contexto_dom, bloqueio = aguardar_janela_aposta(page, aposta, planos)
        if bloqueio is not None:
            print(f"⚠️ Ordem não executada: {bloqueio['motivo']}")
            return bloqueio

        frame_jogo = contexto_dom["frame"]
        saldo_antes = ler_saldo_atual(page)
        if saldo_antes is None:
            return {
                "status": "FALHOU",
                "motivo": (
                    "Saldo real não pôde ser lido antes da aposta; nenhum clique financeiro foi autorizado"
                ),
                "cliques_alvo": 0,
                "confirmacao": {
                    "confirmada": False,
                    "metodo": "SALDO_INDISPONIVEL",
                },
            }
'''
novo_fluxo = '''        # BUG-038: tudo que é não financeiro sai do caminho crítico de
        # AcceptingBets. O saldo e, quando há uma única denominação, a ficha são
        # preparados antes da abertura. Player/Banker/Tie continuam proibidos até
        # a janela estrutural ficar ABERTA.
        saldo_antes = ler_saldo_atual(page)
        if saldo_antes is None:
            return {
                "status": "FALHOU",
                "motivo": (
                    "Saldo real não pôde ser lido antes da aposta; nenhum clique financeiro foi autorizado"
                ),
                "cliques_alvo": 0,
                "confirmacao": {
                    "confirmada": False,
                    "metodo": "SALDO_INDISPONIVEL",
                },
            }

        preparo_ficha = preselecionar_ficha_unica_antes_da_janela(page, planos)
        if preparo_ficha.get("confirmada") is True:
            ficha_corrente = int(preparo_ficha["ficha"])
            print(
                f"⚡ Ficha R$ {ficha_corrente} preparada antes de AcceptingBets "
                f"({preparo_ficha.get('via', 'PRESELECAO')})."
            )

        # BUG-019/038: principal e proteção Tie precisam estar acionáveis antes do
        # primeiro clique financeiro, mas a preparação não financeira já ocorreu.
        contexto_dom, bloqueio = aguardar_janela_aposta(page, aposta, planos)
        if bloqueio is not None:
            print(f"⚠️ Ordem não executada: {bloqueio['motivo']}")
            return bloqueio

        frame_jogo = contexto_dom["frame"]
'''
substituir(antigo_fluxo, novo_fluxo, "mover saldo e preselecionar antes da janela")

substituir(
    '                        ficha_corrente = int(ficha)\n                        page.wait_for_timeout(150)\n                    elif ficha_contexto.get("modo") == "JA_SELECIONADA":',
    '                        ficha_corrente = int(ficha)\n                    elif ficha_contexto.get("modo") == "JA_SELECIONADA":',
    "remover espera apos ficha",
)

substituir(
    '                        alvo_elemento.click(timeout=2000)\n                        cliques_alvo += 1\n                        page.wait_for_timeout(120)',
    '                        alvo_elemento.click(timeout=750)\n                        cliques_alvo += 1\n                        # O clique Playwright já conclui o ciclo de input. Uma pausa\n                        # mínima preserva o processamento do DOM sem consumir a janela.\n                        page.wait_for_timeout(20)',
    "fast click alvo",
)

substituir(
    '                        page.wait_for_timeout(500)\n\n                        reconexao = status_conexao.get("reconexao_pendente")',
    '                        # 500ms de polling consumiam uma fração grande da janela\n                        # real de aposta. Mantém o event loop responsivo sem busy-wait.\n                        page.wait_for_timeout(50)\n\n                        reconexao = status_conexao.get("reconexao_pendente")',
    "poll fila",
)

if texto == original:
    raise SystemExit("BUG-038: nenhum patch aplicado")

ROBO.write_text(texto, encoding="utf-8")

TEST.write_text('''import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "robo.py").read_text(encoding="utf-8")


class Bug038FastPathContract(unittest.TestCase):
    def test_preparacao_nao_financeira_antecede_janela(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))
        self.assertLess(corpo.index("preselecionar_ficha_unica_antes_da_janela(page, planos)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))

    def test_fast_path_nao_remove_gate_financeiro(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertIn("contexto_atual = avaliar_contexto_janela_aposta(aposta)", corpo)
        self.assertIn('if contexto_atual["estado"] != "ABERTA"', corpo)
        self.assertIn("alvo_elemento.click(timeout=750)", corpo)

    def test_latencias_artificiais_criticas_foram_reduzidas(self):
        inicio = SOURCE.index("def selecionar_ficha_com_confirmacao")
        fim = SOURCE.index("def confirmar_aceite_financeiro_aposta", inicio)
        trecho = SOURCE[inicio:fim]
        self.assertNotIn("page.wait_for_timeout(120)", trecho)
        self.assertIn("page.wait_for_timeout(25)", trecho)
        self.assertIn("hit_elemento.click(timeout=700)", SOURCE)

    def test_loop_executor_polling_rapido(self):
        self.assertIn("page.wait_for_timeout(50)", SOURCE)


if __name__ == "__main__":
    unittest.main()
''', encoding="utf-8")

print("BUG-038 aplicado em robo.py e contrato de regressao criado.")
