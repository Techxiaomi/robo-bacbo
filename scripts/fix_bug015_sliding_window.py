from pathlib import Path

root = Path(__file__).resolve().parents[1]
robo = root / "robo-sync-pilot" / "robo.py"
tests = root / "robo-sync-pilot" / "tests" / "test_pure_logic.py"

text = robo.read_text(encoding="utf-8")
old_round = '''        if chave and chave[0] == "round":
            return True
'''
new_round = '''        if chave and chave[0] == "round":
            ultimo_resultado_chave_em = referencia
            return True
'''
if text.count(old_round) != 1:
    raise SystemExit(f"round dedup: esperado 1 trecho, encontrado {text.count(old_round)}")
text = text.replace(old_round, new_round, 1)

old_fallback = '''        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:
            return True
'''
new_fallback = '''        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:
            # Janela deslizante: enquanto o mesmo Resolved continuar chegando,
            # ele permanece duplicado. Só uma pausa maior que a janela permite
            # que um fingerprint idêntico seja tratado como nova rodada.
            ultimo_resultado_chave_em = referencia
            return True
'''
if text.count(old_fallback) != 1:
    raise SystemExit(f"fallback dedup: esperado 1 trecho, encontrado {text.count(old_fallback)}")
robo.write_text(text.replace(old_fallback, new_fallback, 1), encoding="utf-8")

text = tests.read_text(encoding="utf-8")
anchor = '''    def test_fingerprint_igual_depois_da_janela_e_nova_rodada(self):
        dados = self.dados_resolvidos("BankerWon")
        self.processar(dados)
        FakeTime.atual = 103.001
        self.processar(dados)

        self.assertEqual(len(FakeRequests.chamadas), 2)
        self.assertEqual(FakeRequests.chamadas[0]["kwargs"]["json"]["coletor_seq"], 1)
        self.assertEqual(FakeRequests.chamadas[1]["kwargs"]["json"]["coletor_seq"], 2)

'''
insert = anchor + '''    def test_fingerprint_repetido_continuamente_renova_janela(self):
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

'''
if text.count(anchor) != 1:
    raise SystemExit(f"teste âncora: esperado 1 trecho, encontrado {text.count(anchor)}")
tests.write_text(text.replace(anchor, insert, 1), encoding="utf-8")
print("BUG-015 janela deslizante aplicada")
