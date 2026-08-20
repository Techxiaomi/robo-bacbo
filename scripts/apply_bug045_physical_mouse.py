from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

text = ROBO.read_text(encoding="utf-8")
text = text.replace(
    'NOME_ATUALIZACAO = "BUG-044 Clique Nativo apos Limpeza de Interface"',
    'NOME_ATUALIZACAO = "BUG-045 Clique Fisico via page.mouse"',
    1,
)

anchor = '''def clicar_superficie_ficha_playwright(page, elemento):\n'''
helper = '''def clique_fisico_humano(page, elemento):\n    """Move o ponteiro ate o centro do elemento e executa down/up reais via page.mouse."""\n    try:\n        box = elemento.bounding_box()\n        if not box:\n            return {\n                "acionada": False,\n                "relacao": "SEM_BOUNDING_BOX",\n                "motivo": "Elemento fora da area visivel para calcular bounding_box",\n            }\n        largura = float(box.get("width") or 0.0)\n        altura = float(box.get("height") or 0.0)\n        if largura <= 0 or altura <= 0:\n            return {\n                "acionada": False,\n                "relacao": "BOUNDING_BOX_INVALIDO",\n                "motivo": "Bounding box sem dimensoes positivas",\n            }\n        x = float(box["x"]) + largura / 2.0\n        y = float(box["y"]) + altura / 2.0\n        page.mouse.move(x, y, steps=10)\n        page.wait_for_timeout(100)\n        page.mouse.down()\n        page.wait_for_timeout(150)\n        page.mouse.up()\n        page.wait_for_timeout(300)\n        return {\n            "acionada": True,\n            "relacao": "MOUSE_FISICO",\n            "via": "PLAYWRIGHT_PAGE_MOUSE",\n            "x": x,\n            "y": y,\n        }\n    except Exception as erro:\n        return {\n            "acionada": False,\n            "relacao": type(erro).__name__,\n            "motivo": f"falha no clique fisico ({type(erro).__name__})",\n        }\n\n\n'''
if helper not in text:
    if anchor not in text:
        raise SystemExit("anchor helper ficha nao encontrado")
    text = text.replace(anchor, helper + anchor, 1)

pattern_chip = re.compile(
    r'def clicar_superficie_ficha_playwright\(page, elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao',
    re.S,
)
new_chip = '''def clicar_superficie_ficha_playwright(page, elemento):
    """Usa page.mouse para reproduzir a trajetoria fisica ate a ficha canonica."""
    resultado = clique_fisico_humano(page, elemento)
    if resultado.get("acionada") is True:
        return {"acionada": True, "relacao": "MOUSE_FISICO", "via": "PLAYWRIGHT_PAGE_MOUSE"}
    return resultado


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    if 'relacao": "MOUSE_FISICO"' not in text:
        raise SystemExit(f"helper ficha BUG-045: esperado 1 bloco, encontrado {count}")

pattern_target = re.compile(
    r'def clicar_alvo_financeiro_playwright\(page, elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta',
    re.S,
)
new_target = '''def clicar_alvo_financeiro_playwright(page, elemento):
    """Usa page.mouse no centro do alvo financeiro canonico."""
    resultado = clique_fisico_humano(page, elemento)
    if resultado.get("acionada") is True:
        return {"acionada": True, "relacao": "MOUSE_FISICO"}
    return resultado


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    if text.count('relacao": "MOUSE_FISICO"') < 2:
        raise SystemExit(f"helper alvo BUG-045: esperado 1 bloco, encontrado {count}")

# O atraso de 2500 ms deve permanecer rigidamente antes da primeira leitura do saldo.
needle = '''    page.wait_for_timeout(2500)\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n    ultimo_saldo = None\n    ultimo_debito = None\n\n    while time.monotonic() <= prazo:\n        saldo_atual = ler_saldo_atual(page)\n'''
if needle not in text:
    raise SystemExit("contrato de 2500ms antes da primeira leitura de saldo nao encontrado")
text = text.replace(
    '# BUG-044: depois do clique financeiro nativo, a Evolution pode levar mais de 2 s para',
    '# BUG-045: depois do mouse.up financeiro, a Evolution pode levar mais de 2 s para',
    1,
)
ROBO.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
old = '''        self.assertEqual(SOURCE.count('elemento.click(force=True, timeout=1200)'), 2)\n        self.assertNotIn('elemento.dispatch_event("pointerdown")', SOURCE)\n        self.assertNotIn('elemento.dispatch_event("pointerup")', SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n        atraso = SOURCE.index("page.wait_for_timeout(2500)")\n        primeira_leitura = SOURCE.index("saldo_atual = ler_saldo_atual(page)", atraso)\n        self.assertLess(atraso, primeira_leitura)\n'''
new = '''        self.assertIn("def clique_fisico_humano(page, elemento):", SOURCE)\n        self.assertIn("page.mouse.move(x, y, steps=10)", SOURCE)\n        self.assertIn("page.mouse.down()", SOURCE)\n        self.assertIn("page.wait_for_timeout(150)", SOURCE)\n        self.assertIn("page.mouse.up()", SOURCE)\n        self.assertIn("page.wait_for_timeout(300)", SOURCE)\n        self.assertNotIn('elemento.click(force=True, timeout=1200)', SOURCE)\n        self.assertNotIn('elemento.dispatch_event("pointerdown")', SOURCE)\n        self.assertNotIn('elemento.dispatch_event("pointerup")', SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n        atraso = SOURCE.index("page.wait_for_timeout(2500)")\n        primeira_leitura = SOURCE.index("saldo_atual = ler_saldo_atual(page)", atraso)\n        self.assertLess(atraso, primeira_leitura)\n'''
if old not in text:
    if 'page.mouse.move(x, y, steps=10)' not in text:
        raise SystemExit("contrato clique BUG-044 nao encontrado")
else:
    text = text.replace(old, new, 1)
FAST.write_text(text, encoding="utf-8")

print("BUG-045 aplicado: page.mouse com steps=10 em ficha/alvo; 2500ms preservados antes da primeira leitura de saldo.")
