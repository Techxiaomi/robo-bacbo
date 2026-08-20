from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

text = ROBO.read_text(encoding="utf-8")
text = text.replace(
    'NOME_ATUALIZACAO = "BUG-043 Limpeza Preventiva de Modal"',
    'NOME_ATUALIZACAO = "BUG-044 Clique Nativo apos Limpeza de Interface"',
    1,
)

pattern_chip = re.compile(
    r'def clicar_superficie_ficha_playwright\(page, elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao',
    re.S,
)
new_chip = '''def clicar_superficie_ficha_playwright(page, elemento):
    """Executa clique nativo Playwright na ficha canonica apos limpeza preventiva da UI."""
    try:
        # BUG-044: com o overlay preventivamente removido, volta ao clique nativo
        # do Playwright para gerar a sequencia completa de eventos de ponteiro/mouse.
        # force=True ignora somente os actionability checks residuais; o clique do
        # Playwright continua sendo entregue no centro do proprio elemento canonico.
        elemento.click(force=True, timeout=1200)
        return {"acionada": True, "relacao": "CLIQUE_NATIVO_FORCE", "via": "PLAYWRIGHT_CLICK"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no clique nativo da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    if 'relacao": "CLIQUE_NATIVO_FORCE"' not in text:
        raise SystemExit(f"helper ficha: esperado 1 bloco, encontrado {count}")

pattern_target = re.compile(
    r'def clicar_alvo_financeiro_playwright\(page, elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta',
    re.S,
)
new_target = '''def clicar_alvo_financeiro_playwright(page, elemento):
    """Executa clique nativo Playwright no alvo financeiro canonico apos limpeza da UI."""
    try:
        # BUG-044: o clique nativo produz pointerdown/mousedown/pointerup/mouseup/click,
        # evitando a limitacao dos dispatch_event sinteticos observada na mesa real.
        elemento.click(force=True, timeout=1200)
        return {"acionada": True, "relacao": "CLIQUE_NATIVO_FORCE"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no clique nativo do alvo ({type(erro).__name__})",
        }


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    if text.count('relacao": "CLIQUE_NATIVO_FORCE"') < 2:
        raise SystemExit(f"helper alvo: esperado 1 bloco, encontrado {count}")

# Mantem rigidamente a espera de 2500 ms antes da primeira leitura de saldo.
needle = '''    page.wait_for_timeout(2500)\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n    ultimo_saldo = None\n    ultimo_debito = None\n\n    while time.monotonic() <= prazo:\n        saldo_atual = ler_saldo_atual(page)\n'''
if needle not in text:
    raise SystemExit("contrato de 2500ms antes da primeira leitura de saldo nao encontrado")
text = text.replace(
    '# BUG-042: depois do pointerup financeiro, a Evolution pode levar mais de 2 s para',
    '# BUG-044: depois do clique financeiro nativo, a Evolution pode levar mais de 2 s para',
    1,
)
ROBO.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
old = '''        self.assertEqual(SOURCE.count('elemento.dispatch_event("pointerdown")'), 2)\n        self.assertEqual(SOURCE.count('elemento.dispatch_event("pointerup")'), 2)\n        self.assertIn("page.wait_for_timeout(100)", SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertNotIn('position={"x": largura / 2.0', SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n'''
new = '''        self.assertEqual(SOURCE.count('elemento.click(force=True, timeout=1200)'), 2)\n        self.assertNotIn('elemento.dispatch_event("pointerdown")', SOURCE)\n        self.assertNotIn('elemento.dispatch_event("pointerup")', SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n        atraso = SOURCE.index("page.wait_for_timeout(2500)")\n        primeira_leitura = SOURCE.index("saldo_atual = ler_saldo_atual(page)", atraso)\n        self.assertLess(atraso, primeira_leitura)\n'''
if old not in text:
    if "SOURCE.count('elemento.click(force=True, timeout=1200)')" not in text:
        raise SystemExit("contrato de clique BUG-042 nao encontrado")
else:
    text = text.replace(old, new, 1)
FAST.write_text(text, encoding="utf-8")

print("BUG-044 aplicado: clique nativo force=True em ficha/alvo; 2500ms preservados antes da primeira leitura de saldo.")
