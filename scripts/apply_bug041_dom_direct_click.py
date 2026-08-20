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
        print(f"{label}: já aplicado")
        return text
    if count != 1:
        raise SystemExit(f"{label}: esperado 1 trecho, encontrado {count}")
    return text.replace(old, new, 1)


text = ROBO.read_text(encoding="utf-8")
text = replace_once(
    text,
    'NOME_ATUALIZACAO = "BUG-040 Sincronia UI e Clique Central"',
    'NOME_ATUALIZACAO = "BUG-041 Clique DOM Direto"',
    "versão BUG-041",
)

pattern_chip = re.compile(
    r'def clicar_superficie_ficha_playwright\(elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao',
    re.S,
)
new_chip = '''def clicar_superficie_ficha_playwright(elemento):
    """Dispara click DOM diretamente na ficha canônica, sem actionability do Playwright."""
    try:
        # BUG-041: a Evolution mantém overlays/camadas que podem bloquear o
        # actionability check mesmo depois da animação estabilizar. O elemento
        # já foi identificado pelo data-role/data-value e validado como visível
        # no preflight; aqui o clique é disparado no próprio nó canônico.
        elemento.evaluate("el => el.click()")
        return {"acionada": True, "relacao": "DOM_DIRETO", "via": "DOM_EVALUATE"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no click DOM direto da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    raise SystemExit(f"helper ficha BUG-041: esperado 1 bloco, encontrado {count}")

pattern_target = re.compile(
    r'def clicar_alvo_financeiro_playwright\(elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta',
    re.S,
)
new_target = '''def clicar_alvo_financeiro_playwright(elemento):
    """Dispara click DOM diretamente no alvo financeiro canônico, sem force=True."""
    try:
        # BUG-041: não usa locator.click(), position ou force=True. O clique é
        # disparado no próprio [data-role='bacbo-bet-spot-*'] já aprovado pelo
        # preflight. A confirmação financeira por saldo continua obrigatória.
        elemento.evaluate("el => el.click()")
        return {"acionada": True, "relacao": "DOM_DIRETO"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no click DOM direto do alvo ({type(erro).__name__})",
        }


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    raise SystemExit(f"helper alvo BUG-041: esperado 1 bloco, encontrado {count}")

ROBO.write_text(text, encoding="utf-8")

text = PURE.read_text(encoding="utf-8")
old = '    assert.match(executorPythonSource, /position=\\{\"x\": largura \\/ 2\\.0, \"y\": altura \\/ 2\\.0\\\}/);\n'
new = (
    '    assert.equal((executorPythonSource.match(/elemento\\.evaluate\\(\"el => el\\.click\\(\\)\"\\)/g) || []).length, 2);\n'
    '    assert.doesNotMatch(executorPythonSource, /position=\\{\"x\": largura \\/ 2\\.0/);\n'
)
text = replace_once(text, old, new, "contrato Node clique DOM")
PURE.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
old = '        self.assertIn(\'position={"x": largura / 2.0, "y": altura / 2.0}\', SOURCE)\n'
new = (
    '        self.assertEqual(SOURCE.count(\'elemento.evaluate("el => el.click()")\'), 2)\n'
    '        self.assertNotIn(\'position={"x": largura / 2.0\', SOURCE)\n'
)
text = replace_once(text, old, new, "contrato Python clique DOM")
FAST.write_text(text, encoding="utf-8")

text = DOM.read_text(encoding="utf-8")
old_chip = '''<div id="wrap">\n  <div id="chip5" data-role="chip" data-value="5">5\n    <span id="surface" onpointerdown="window.__surfacePointerDown++" onclick="\n      window.__surfaceClicks++;\n      document.getElementById('chip5').classList.add('selected');\n    ">superfície</span>\n  </div>\n</div>'''
new_chip = '''<div id="wrap">\n  <div id="chip5" data-role="chip" data-value="5" onclick="\n    window.__surfaceClicks++;\n    document.getElementById('chip5').classList.add('selected');\n  ">5\n    <span id="surface" onpointerdown="window.__surfacePointerDown++">overlay</span>\n  </div>\n</div>'''
text = replace_once(text, old_chip, new_chip, "fixture ficha DOM direto")

old_roundtrip = '''<div class="wrap"><div id="chip5" class="chip" data-role="chip" data-value="5">5\n  <span class="surface" onclick="escolher(5)">superfície 5</span></div></div>\n<div class="wrap"><div class="chip" data-role="chip" data-value="10">10\n  <span class="surface" onclick="escolher(10)">superfície 10</span></div></div>'''
new_roundtrip = '''<div class="wrap"><div id="chip5" class="chip" data-role="chip" data-value="5" onclick="escolher(5)">5\n  <span class="surface">overlay 5</span></div></div>\n<div class="wrap"><div class="chip" data-role="chip" data-value="10" onclick="escolher(10)">10\n  <span class="surface">overlay 10</span></div></div>'''
text = replace_once(text, old_roundtrip, new_roundtrip, "fixture roundtrip DOM direto")

old_target = '''<div id="wrap">\n  <button id="player" data-role="bacbo-bet-spot-Player">Player\n    <span id="surface" onclick="window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'; window.__surfaceClicks=(window.__surfaceClicks||0)+1">Player surface</span>\n  </button>\n</div>'''
new_target = '''<div id="wrap">\n  <button id="player" data-role="bacbo-bet-spot-Player" onclick="window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'; window.__surfaceClicks=(window.__surfaceClicks||0)+1">Player\n    <span id="surface">overlay</span>\n  </button>\n</div>'''
text = replace_once(text, old_target, new_target, "fixture alvo DOM direto")

text = replace_once(
    text,
    '            self.assertEqual(frame.evaluate("window.__surfacePointerDown"), 1)\n',
    '            self.assertEqual(frame.evaluate("window.__surfacePointerDown"), 0)\n',
    "DOM click não produz pointerdown",
)

old_dealing = '''            # BUG-038: selecionar a ficha e preparacao nao financeira; o alvo continua\n            # proibido enquanto Dealing/FirstDie e demais stages nao apostaveis estiverem ativos.\n            self.assertEqual(frame.evaluate("window.__chipClicks")["10"], 1)\n'''
new_dealing = '''            # BUG-040/041: a ficha também só é acionada depois de AcceptingBets\n            # estabilizar; em Dealing não há clique de ficha nem de alvo.\n            self.assertEqual(frame.evaluate("window.__chipClicks")["10"], 0)\n'''
text = replace_once(text, old_dealing, new_dealing, "contrato sem pré-seleção em Dealing")
DOM.write_text(text, encoding="utf-8")

print("BUG-041 aplicado: click DOM direto em ficha/alvo, delays e confirmação por saldo preservados.")
