from pathlib import Path

path = Path(__file__).resolve().parents[1] / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"
text = path.read_text(encoding="utf-8")
old = '''    def test_bug028_stage_dealing_nao_autoriza_dom_visivel(self):
        pagina = self.nova_pagina("/game.html")
        self.configurar_janela(25, "Dealing", timeout=1.0)
'''
new = '''    def test_bug038_stage_dealing_pode_preparar_ficha_mas_nao_autoriza_alvo(self):
        pagina = self.nova_pagina("/game.html")
        self.configurar_janela(25, "Dealing", timeout=1.0)
'''
if text.count(old) != 1:
    raise SystemExit(f"BUG-038: cabecalho esperado nao encontrado exatamente uma vez: {text.count(old)}")
text = text.replace(old, new, 1)
old_assert = '            self.assertEqual(frame.evaluate("window.__chipClicks")["10"], 0)\n            self.assertEqual(frame.evaluate("window.__targetClicks")["playerA"], 0)'
new_assert = '            # BUG-038: selecionar a ficha e preparacao nao financeira; o alvo continua\n            # proibido enquanto Dealing/FirstDie e demais stages nao apostaveis estiverem ativos.\n            self.assertEqual(frame.evaluate("window.__chipClicks")["10"], 1)\n            self.assertEqual(frame.evaluate("window.__targetClicks")["playerA"], 0)'
if text.count(old_assert) != 1:
    raise SystemExit(f"BUG-038: assert esperado nao encontrado exatamente uma vez: {text.count(old_assert)}")
text = text.replace(old_assert, new_assert, 1)
path.write_text(text, encoding="utf-8")
print("Contrato Playwright BUG-038 alinhado: ficha pode ser preparada; alvo financeiro continua bloqueado.")
