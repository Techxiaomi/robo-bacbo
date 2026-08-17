from pathlib import Path

root = Path(__file__).resolve().parents[1]
robo = root / "robo-sync-pilot" / "robo.py"
tests = root / "robo-sync-pilot" / "tests" / "test_pure_logic.py"

# Edita por linhas para não depender de CRLF/LF ou de blocos textuais grandes.
text = robo.read_text(encoding="utf-8-sig")
lines = text.splitlines()

round_indexes = [
    i for i, line in enumerate(lines)
    if line.strip() == 'if chave and chave[0] == "round":'
]
if len(round_indexes) != 1:
    raise SystemExit(f"round dedup: esperado 1 marcador, encontrado {len(round_indexes)}")
round_i = round_indexes[0]
if lines[round_i + 1].strip() != "ultimo_resultado_chave_em = referencia":
    lines.insert(round_i + 1, "            ultimo_resultado_chave_em = referencia")

fallback_indexes = [
    i for i, line in enumerate(lines)
    if line.strip() == "if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:"
]
if len(fallback_indexes) != 1:
    raise SystemExit(f"fallback dedup: esperado 1 marcador, encontrado {len(fallback_indexes)}")
fallback_i = fallback_indexes[0]
if lines[fallback_i + 1].strip() != "# Janela deslizante: enquanto o mesmo Resolved continuar chegando,":
    lines[fallback_i + 1:fallback_i + 1] = [
        "            # Janela deslizante: enquanto o mesmo Resolved continuar chegando,",
        "            # ele permanece duplicado. Só uma pausa maior que a janela permite",
        "            # que um fingerprint idêntico seja tratado como nova rodada.",
        "            ultimo_resultado_chave_em = referencia",
    ]

robo.write_text("\n".join(lines) + "\n", encoding="utf-8")

text = tests.read_text(encoding="utf-8-sig")
method_name = "def test_fingerprint_repetido_continuamente_renova_janela(self):"
if method_name not in text:
    marker = "    def test_round_id_repetido_e_ignorado_mesmo_fora_da_janela(self):"
    if text.count(marker) != 1:
        raise SystemExit(f"teste marcador: esperado 1, encontrado {text.count(marker)}")
    new_test = '''    def test_fingerprint_repetido_continuamente_renova_janela(self):
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
    text = text.replace(marker, new_test + marker, 1)

tests.write_text(text, encoding="utf-8")
print("BUG-015 janela deslizante aplicada")
