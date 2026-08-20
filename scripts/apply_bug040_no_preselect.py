from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count == 0 and new in text:
        print(f"{label}: já aplicado")
        return text
    if count != 1:
        raise SystemExit(f"{label}: esperado 1 trecho, encontrado {count}")
    return text.replace(old, new, 1)


text = ROBO.read_text(encoding="utf-8")
old = '''        # BUG-038: tudo que é não financeiro sai do caminho crítico de\n        # AcceptingBets. O saldo e, quando há uma única denominação, a ficha são\n        # preparados antes da abertura. Player/Banker/Tie continuam proibidos até\n        # a janela estrutural ficar ABERTA.\n        saldo_antes = ler_saldo_atual(page)\n'''
new = '''        # BUG-038/040: a leitura do saldo continua fora do caminho crítico, mas a\n        # ficha não é mais pré-selecionada antes da abertura. A Evolution anima as\n        # fichas no início de AcceptingBets; toda seleção de ficha ocorre somente\n        # depois do delay de estabilização de 1500 ms da janela ABERTA.\n        saldo_antes = ler_saldo_atual(page)\n'''
text = replace_once(text, old, new, "comentário preparação")

old = '''        preparo_ficha = preselecionar_ficha_unica_antes_da_janela(page, planos)\n        if preparo_ficha.get("confirmada") is True:\n            ficha_corrente = int(preparo_ficha["ficha"])\n            print(\n                f"⚡ Ficha R$ {ficha_corrente} preparada antes de AcceptingBets "\n                f"({preparo_ficha.get('via', 'PRESELECAO')})."\n            )\n\n        # BUG-019/038: principal e proteção Tie precisam estar acionáveis antes do\n        # primeiro clique financeiro, mas a preparação não financeira já ocorreu.\n'''
new = '''        # BUG-019/040: principal e proteção Tie precisam estar acionáveis antes do\n        # primeiro clique financeiro. A ficha será selecionada somente depois que\n        # AcceptingBets permanecer ABERTA durante o delay de animação.\n'''
text = replace_once(text, old, new, "remove pré-seleção runtime")
ROBO.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
old = '''    def test_preparacao_nao_financeira_antecede_janela(self):\n        inicio = SOURCE.index("def executar_aposta_na_tela")\n        fim = SOURCE.index("def parsear_valor_monetario", inicio)\n        corpo = SOURCE[inicio:fim]\n        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))\n        self.assertLess(corpo.index("preselecionar_ficha_unica_antes_da_janela(page, planos)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))\n'''
new = '''    def test_preparacao_nao_financeira_antecede_janela(self):\n        inicio = SOURCE.index("def executar_aposta_na_tela")\n        fim = SOURCE.index("def parsear_valor_monetario", inicio)\n        corpo = SOURCE[inicio:fim]\n        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))\n        self.assertNotIn("preselecionar_ficha_unica_antes_da_janela(page, planos)", corpo)\n        self.assertIn("page.wait_for_timeout(1500)", SOURCE)\n'''
text = replace_once(text, old, new, "contrato sem pré-seleção")
FAST.write_text(text, encoding="utf-8")
print("BUG-040: pré-seleção antes de AcceptingBets removida do runtime.")
