from pathlib import Path

root = Path(__file__).resolve().parents[1]
robo = root / "robo-sync-pilot" / "robo.py"
tests = root / "robo-sync-pilot" / "tests" / "test_pure_logic.py"

text = robo.read_text(encoding="utf-8")
old = '''    if mesma_chave:\n        if chave and chave[0] == "round":\n            return True\n        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:\n            return True\n\n    ultimo_resultado_chave = chave\n    ultimo_resultado_chave_em = referencia\n    return False\n'''
new = '''    if mesma_chave:\n        if chave and chave[0] == "round":\n            ultimo_resultado_chave_em = referencia\n            return True\n        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:\n            # Janela deslizante: enquanto o mesmo Resolved continuar chegando,\n            # ele permanece duplicado. Só uma pausa maior que a janela permite\n            # que um fingerprint idêntico seja tratado como nova rodada.\n            ultimo_resultado_chave_em = referencia\n            return True\n\n    ultimo_resultado_chave = chave\n    ultimo_resultado_chave_em = referencia\n    return False\n'''
if text.count(old) != 1:
    raise SystemExit(f"helper dedup: esperado 1 trecho, encontrado {text.count(old)}")
robo.write_text(text.replace(old, new, 1), encoding="utf-8")

text = tests.read_text(encoding="utf-8")
anchor = '''    def test_fingerprint_igual_depois_da_janela_e_nova_rodada(self):\n        dados = self.dados_resolvidos("BankerWon")\n        self.processar(dados)\n        FakeTime.atual = 103.001\n        self.processar(dados)\n\n        self.assertEqual(len(FakeRequests.chamadas), 2)\n        self.assertEqual(FakeRequests.chamadas[0]["kwargs"]["json"]["coletor_seq"], 1)\n        self.assertEqual(FakeRequests.chamadas[1]["kwargs"]["json"]["coletor_seq"], 2)\n\n'''
insert = anchor + '''    def test_fingerprint_repetido_continuamente_renova_janela(self):\n        dados = self.dados_resolvidos("PlayerWon")\n        self.processar(dados)\n        for instante in (102.0, 104.0, 106.0):\n            FakeTime.atual = instante\n            self.processar(dados)\n\n        self.assertEqual(len(FakeRequests.chamadas), 1)\n        self.assertEqual(self.ns["coletor_seq"], 1)\n\n        FakeTime.atual = 109.001\n        self.processar(dados)\n        self.assertEqual(len(FakeRequests.chamadas), 2)\n        self.assertEqual(self.ns["coletor_seq"], 2)\n\n'''
if text.count(anchor) != 1:
    raise SystemExit(f"teste âncora: esperado 1 trecho, encontrado {text.count(anchor)}")
tests.write_text(text.replace(anchor, insert, 1), encoding="utf-8")
print("BUG-015 janela deslizante aplicada")
