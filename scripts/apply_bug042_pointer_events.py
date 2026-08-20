from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
PURE = ROOT / "robo-bacbo" / "support" / "pure-logic-suite.js"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"
DOM = ROOT / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count == 0 and new in text:
        print(f"{label}: ja aplicado")
        return text
    if count != 1:
        raise SystemExit(f"{label}: esperado 1 trecho, encontrado {count}")
    return text.replace(old, new, 1)


text = ROBO.read_text(encoding="utf-8")
text = replace_once(
    text,
    'NOME_ATUALIZACAO = "BUG-041 Clique DOM Direto"',
    'NOME_ATUALIZACAO = "BUG-042 Pointer Events e Confirmação 2500ms"',
    "versao BUG-042",
)

pattern_chip = re.compile(
    r'def clicar_superficie_ficha_playwright\(elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao',
    re.S,
)
new_chip = '''def clicar_superficie_ficha_playwright(page, elemento):
    """Dispara pointerdown/pointerup diretamente na ficha canonica, sem actionability de click()."""
    try:
        # BUG-042: a Evolution pode manter overlays transparentes sobre a ficha.
        # dispatch_event nao executa os actionability checks de locator.click(),
        # mas entrega os eventos ao proprio no canonico identificado no preflight.
        elemento.dispatch_event("pointerdown")
        page.wait_for_timeout(100)
        elemento.dispatch_event("pointerup")
        return {"acionada": True, "relacao": "POINTER_EVENTS", "via": "DISPATCH_EVENT"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no pointerdown/pointerup da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    if 'def clicar_superficie_ficha_playwright(page, elemento):' not in text:
        raise SystemExit(f"helper ficha BUG-042: esperado 1 bloco, encontrado {count}")

text = text.replace(
    'clicar_superficie_ficha_playwright(elemento)',
    'clicar_superficie_ficha_playwright(page, elemento)',
)

pattern_target = re.compile(
    r'def clicar_alvo_financeiro_playwright\(elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta',
    re.S,
)
new_target = '''def clicar_alvo_financeiro_playwright(page, elemento):
    """Dispara pointerdown/pointerup no alvo financeiro canonico, sem locator.click() ou force=True."""
    try:
        # BUG-042: entrega a sequencia de ponteiro diretamente ao componente
        # financeiro ja localizado e validado pelo preflight.
        elemento.dispatch_event("pointerdown")
        page.wait_for_timeout(100)
        elemento.dispatch_event("pointerup")
        return {"acionada": True, "relacao": "POINTER_EVENTS"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no pointerdown/pointerup do alvo ({type(erro).__name__})",
        }


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    if 'def clicar_alvo_financeiro_playwright(page, elemento):' not in text:
        raise SystemExit(f"helper alvo BUG-042: esperado 1 bloco, encontrado {count}")
text = replace_once(
    text,
    'alvo_real = clicar_alvo_financeiro_playwright(alvo_elemento)',
    'alvo_real = clicar_alvo_financeiro_playwright(page, alvo_elemento)',
    "chamada helper alvo",
)
text = replace_once(
    text,
    '    page.wait_for_timeout(2000)\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n',
    '    page.wait_for_timeout(2500)\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n',
    "delay saldo 2500ms",
)
text = text.replace(
    '# BUG-040: depois do clique financeiro, a Evolution pode levar 1–2 s para',
    '# BUG-042: depois do pointerup financeiro, a Evolution pode levar mais de 2 s para',
)
ROBO.write_text(text, encoding="utf-8")

text = PURE.read_text(encoding="utf-8")
text = replace_once(
    text,
    '    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(2000\\)/);\n    assert.equal((executorPythonSource.match(/elemento\\.evaluate\\(\"el => el\\.click\\(\\)\"\\)/g) || []).length, 2);\n',
    '    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(2500\\)/);\n    assert.equal((executorPythonSource.match(/elemento\\.dispatch_event\\(\"pointerdown\"\\)/g) || []).length, 2);\n    assert.equal((executorPythonSource.match(/elemento\\.dispatch_event\\(\"pointerup\"\\)/g) || []).length, 2);\n    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(100\\)/);\n    assert.doesNotMatch(executorPythonSource, /elemento\\.evaluate\\(\"el => el\\.click\\(\\)\"\\)/);\n',
    "contrato Node BUG-042",
)
PURE.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
text = replace_once(
    text,
    '        self.assertIn("clicar_alvo_financeiro_playwright(alvo_elemento)", corpo)\n',
    '        self.assertIn("clicar_alvo_financeiro_playwright(page, alvo_elemento)", corpo)\n',
    "contrato chamada alvo",
)
text = replace_once(
    text,
    '        self.assertIn("page.wait_for_timeout(2000)", SOURCE)\n        self.assertEqual(SOURCE.count(\'elemento.evaluate("el => el.click()")\'), 2)\n',
    '        self.assertIn("page.wait_for_timeout(2500)", SOURCE)\n        self.assertEqual(SOURCE.count(\'elemento.dispatch_event("pointerdown")\'), 2)\n        self.assertEqual(SOURCE.count(\'elemento.dispatch_event("pointerup")\'), 2)\n        self.assertIn("page.wait_for_timeout(100)", SOURCE)\n        self.assertNotIn(\'elemento.evaluate("el => el.click()")\', SOURCE)\n',
    "contrato pointer events",
)
FAST.write_text(text, encoding="utf-8")

# Os fixtures controlados passam a reagir ao pointerup, representando o listener
# customizado que motivou o BUG-042. Mantem o restante da estrutura dos testes.
text = DOM.read_text(encoding="utf-8")
text = text.replace("onclick=", "onpointerup=")
DOM.write_text(text, encoding="utf-8")

print("BUG-042 aplicado: pointerdown/up em ficha e alvo; 100ms entre eventos; 2500ms antes da primeira leitura de saldo.")
