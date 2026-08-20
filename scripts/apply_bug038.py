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
    "versao"
)

substituir(
    '        hit_elemento.click(timeout=2000)\n        return {"acionada": True, "relacao": relacao, "via": "PLAYWRIGHT_REAL"}\n    except PlaywrightTimeoutError:\n        return {"acionada": False, "relacao": "TIMEOUT", "motivo": "superfície não ficou acionável em 2s"}',
    '        hit_elemento.click(timeout=700)\n        return {"acionada": True, "relacao": relacao, "via": "PLAYWRIGHT_REAL"}\n    except PlaywrightTimeoutError:\n        return {"acionada": False, "relacao": "TIMEOUT", "motivo": "superfície não ficou acionável em 700ms"}',
    "timeout superficie ficha"
)

substituir(
    '    try:\n        elemento.click(timeout=2000)\n        return {"confirmada": True, "via": "PLAYWRIGHT"}\n',
    '    try:\n        elemento.click(timeout=700)\n        return {"confirmada": True, "via": "PLAYWRIGHT"}\n',
    "timeout selecao ficha"
)

substituir(
    '    # A conclusão do clique Playwright é a mesma evidência operacional aceita\n    # no caminho direto que já funcionava manualmente. O clique ainda é\n    # estritamente não financeiro; stage/seq são revalidados antes do alvo.\n    page.wait_for_timeout(120)\n    return {\n        "confirmada": True,\n        "via": f"SUPERFICIE_PLAYWRIGHT_{superficie.get(\'relacao\', \'DOM\')}"\n    }\n\n\ndef formatar_diagnostico_janela',
    '    # Selecionar a ficha não cria exposição financeira. Não há sleep artificial\n    # aqui: o caminho crítico deve chegar ao alvo enquanto AcceptingBets ainda está\n    # vigente; stage/seq continuam revalidados imediatamente antes do clique financeiro.\n    return {\n        "confirmada": True,\n        "via": f"SUPERFICIE_PLAYWRIGHT_{superficie.get(\'relacao\', \'DOM\')}"\n    }\n\n\ndef preselecionar_ficha_unica_antes_da_janela(page, planos):\n    """Tenta preparar uma única denominação antes da janela; nunca clica alvo financeiro."""\n    fichas = sorted({\n        int(ficha)\n        for plano in (planos or [])\n        for ficha, _ in plano.get("cliques_necessarios", [])\n    })\n    if len(fichas) != 1:\n        return {"confirmada": False, "ficha": None, "motivo": "PLANO_MULTIFICHAS"}\n\n    ficha = fichas[0]\n    for frame in list(getattr(page, "frames", []) or []):\n        ficha_contexto, _, _ = localizar_ficha_apostavel(frame, ficha)\n        if ficha_contexto is None:\n            continue\n        if ficha_contexto.get("modo") == "JA_SELECIONADA":\n            return {"confirmada": True, "ficha": ficha, "via": "JA_SELECIONADA"}\n\n        elemento = ficha_contexto.get("elemento")\n        if elemento is None:\n            continue\n        try:\n            # Preparação não financeira: tentativa curta e oportunista. Se a mesa\n            # ainda não aceitar seleção de ficha, o fast path simplesmente cai no\n            # caminho normal assim que AcceptingBets abrir.\n            elemento.click(timeout=300)\n            return {"confirmada": True, "ficha": ficha, "via": "PRESELECAO_PLAYWRIGHT"}\n        except Exception:\n            continue\n\n    return {"confirmada": False, "ficha": ficha, "motivo": "PRESELECAO_INDISPONIVEL"}\n\n\ndef formatar_diagnostico_janela',
    "helper preselecionar ficha"
)

substituir(
    'def aguardar_janela_aposta(page, aposta, planos):\n    sincronizar = aposta.get("sincronizar_janela") is True\n    prazo = time.monotonic() + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS',
    'def aguardar_janela_aposta(page, aposta, planos):\n    sincronizar = aposta.get("sincronizar_janela") is True\n    inicio_espera = time.monotonic()\n    prazo = inicio_espera + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS',
    "inicio espera janela"
)

substituir(
    '            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            if contexto_dom is not None:\n                return contexto_dom, None',
    '            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            if contexto_dom is not None:\n                if sincronizar:\n                    print(\n                        f"⚡ Ordem {aposta.get(\'order_id\', \'n/a\')}: DOM pronto em "\n                        f"{(time.monotonic() - inicio_espera) * 1000:.0f}ms; iniciando fast path financeiro."\n                    )\n                return contexto_dom, None',
    "telemetria janela pronta"
)

substituir(
    '        page.wait_for_timeout(100)\n\n\ndef confirmar_aceite_financeiro_aposta',
    '        page.wait_for_timeout(25)\n\n\ndef confirmar_aceite_financeiro_aposta',
    "poll janela"
)

substituir(
    '        # BUG-019: principal e proteção Tie precisam estar acionáveis antes do primeiro clique real.\n        contexto_dom, bloqueio = aguardar_janela_aposta(page, aposta, planos)\n        if bloqueio is not None:\n            print(f"⚠️ Ordem não executada: {bloqueio[\'motivo\']}")\n            return bloqueio\n\n        frame_jogo = contexto_dom["frame"]\n        saldo_antes = ler_saldo_atual(page)\n        if saldo_antes is None:\n            return {\n                "status": "FALHOU",\n                "motivo": (\n                    "Saldo real não pôde ser lido antes da aposta; nenhum clique financeiro foi autorizado"\n                ),\n                "cliques_alvo": 0,\n                "confirmacao": {\n                    "confirmada": False,\n                    "metodo": "SALDO_INDISPONIVEL",\n                },\n            }\n',
    '        # BUG-038: tudo que é não financeiro deve sair do caminho crítico de\n        # AcceptingBets. O saldo e, quando há uma única denominação, a ficha são\n        # preparados antes da abertura. Player/Banker/Tie continuam proibidos até\n        # a janela estrutural ficar ABERTA.\n        saldo_antes = ler_saldo_atual(page)\n        if saldo_antes is None:\n            return {\n                "status": "FALHOU",\n                "motivo": (\n                    "Saldo real não pôde ser lido antes da aposta; nenhum clique financeiro foi autorizado"\n                ),\n                "cliques_alvo": 0,\n                "confirmacao": {\n                    "confirmada": False,\n                    "metodo": "SALDO_INDISPONIVEL",\n                },\n            }\n\n        preparo_ficha = preselecionar_ficha_unica_antes_da_janela(page, planos)\n        if preparo_ficha.get("confirmada") is True:\n            ficha_corrente = int(preparo_ficha["ficha"])\n            print(\n                f"⚡ Ficha R$ {ficha_corrente} preparada antes de AcceptingBets "\n                f"({preparo_ficha.get(\'via\', \'PRESELECAO\')})."\n            )\n\n        # BUG-019/038: principal e proteção Tie precisam estar acionáveis antes do\n        # primeiro clique financeiro, mas a preparação não financeira já ocorreu.\n        contexto_dom, bloqueio = aguardar_janela_aposta(page, aposta, planos)\n        if bloqueio is not None:\n            print(f"⚠️ Ordem não executada: {bloqueio[\'motivo\']}")\n            return bloqueio\n\n        frame_jogo = contexto_dom["frame"]\n',
    "mover saldo e preselecionar antes da janela"
)

substituir(
    '                        ficha_corrente = int(ficha)\n                        page.wait_for_timeout(150)\n                    elif ficha_contexto.get("modo") == "JA_SELECIONADA":',
    '                        ficha_corrente = int(ficha)\n                    elif ficha_contexto.get("modo") == "JA_SELECIONADA":',
    "remover espera apos ficha"
)

substituir(
    '                        alvo_elemento.click(timeout=2000)\n                        cliques_alvo += 1\n                        page.wait_for_timeout(120)',
    '                        alvo_elemento.click(timeout=750)\n                        cliques_alvo += 1\n                        # O clique Playwright já conclui o ciclo de input. Uma pausa\n                        # mínima preserva o processamento do DOM sem consumir a janela.\n                        page.wait_for_timeout(20)',
    "fast click alvo"
)

substituir(
    '                        page.wait_for_timeout(500)\n\n                        reconexao = status_conexao.get("reconexao_pendente")',
    '                        # 500ms de polling consumiam uma fração grande da janela\n                        # real de aposta. Mantém o event loop responsivo sem busy-wait.\n                        page.wait_for_timeout(50)\n\n                        reconexao = status_conexao.get("reconexao_pendente")',
    "poll fila"
)

if texto == original:
    raise SystemExit("BUG-038: nenhum patch aplicado")

ROBO.write_text(texto, encoding="utf-8")

TEST.write_text('''import pathlib\nimport unittest\n\n\nROOT = pathlib.Path(__file__).resolve().parents[1]\nSOURCE = (ROOT / "robo.py").read_text(encoding="utf-8")\n\n\nclass Bug038FastPathContract(unittest.TestCase):\n    def test_preparacao_nao_financeira_antecede_janela(self):\n        inicio = SOURCE.index("def executar_aposta_na_tela")\n        fim = SOURCE.index("def parsear_valor_monetario", inicio)\n        corpo = SOURCE[inicio:fim]\n        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))\n        self.assertLess(corpo.index("preselecionar_ficha_unica_antes_da_janela(page, planos)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))\n\n    def test_fast_path_nao_remove_gate_financeiro(self):\n        inicio = SOURCE.index("def executar_aposta_na_tela")\n        fim = SOURCE.index("def parsear_valor_monetario", inicio)\n        corpo = SOURCE[inicio:fim]\n        self.assertIn("contexto_atual = avaliar_contexto_janela_aposta(aposta)", corpo)\n        self.assertIn("if contexto_atual[\\\"estado\\\"] != \\\"ABERTA\\\"", corpo)\n        self.assertIn("alvo_elemento.click(timeout=750)", corpo)\n\n    def test_latencias_artificiais_criticas_foram_reduzidas(self):\n        inicio = SOURCE.index("def selecionar_ficha_com_confirmacao")\n        fim = SOURCE.index("def confirmar_aceite_financeiro_aposta", inicio)\n        trecho = SOURCE[inicio:fim]\n        self.assertNotIn("page.wait_for_timeout(120)", trecho)\n        self.assertIn("page.wait_for_timeout(25)", trecho)\n        self.assertIn("hit_elemento.click(timeout=700)", SOURCE)\n\n    def test_loop_executor_polling_rapido(self):\n        self.assertIn("page.wait_for_timeout(50)", SOURCE)\n\n\nif __name__ == "__main__":\n    unittest.main()\n''', encoding="utf-8")

print("BUG-038 aplicado em robo.py e contrato de regressao criado.")
