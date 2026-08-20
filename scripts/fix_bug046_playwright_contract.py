from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
FILE = ROOT / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"
text = FILE.read_text(encoding="utf-8")

# Toda ordem sincronizada de fixture precisa carregar o relógio do Resolved que a originou.
pattern = re.compile(r'(?P<indent>\s*)"coletor_seq_aceite": (?P<value>[^,\n]+),\n(?!\s*"resolved_monotonic_aceite")')
text, count = pattern.subn(
    lambda m: f'{m.group("indent")}"coletor_seq_aceite": {m.group("value")},\n'
              f'{m.group("indent")}"resolved_monotonic_aceite": time.monotonic() - 8.1,\n',
    text,
)
if count < 1 and '"resolved_monotonic_aceite": time.monotonic() - 8.1' not in text:
    raise SystemExit("nenhuma ordem sincronizada localizada para BUG-046")

# A expiração por novo Resolved continua estrutural; o novo waiter não depende do texto
# diagnóstico legado de inspeção DOM para provar essa condição.
text = text.replace('            self.assertIn("última inspeção:", resultado["motivo"])\n', '', 1)
text = text.replace('            self.assertIn("fichas_prontas=", resultado["motivo"])\n', '', 1)
text = text.replace('            self.assertIn("alvos=", resultado["motivo"])\n', '', 1)

# Nome/comentário do teste de Dealing passa a refletir o contrato atual: zero interação
# antes da janela temporal + stage pré-dados.
text = text.replace(
    'def test_bug038_stage_dealing_pode_preparar_ficha_mas_nao_autoriza_alvo(self):',
    'def test_bug046_stage_dealing_nao_autoriza_ficha_nem_alvo(self):',
    1,
)
text = text.replace(
    '# BUG-040/041: a ficha também só é acionada depois de AcceptingBets\n            # estabilizar; em Dealing não há clique de ficha nem de alvo.',
    '# BUG-046: Dealing está fora das fases pré-dados autorizadas; zero clique de ficha/alvo.',
    1,
)

# O clique Playwright simples gera pointerdown real. A expectativa 0 pertencia ao antigo
# fallback de superfície e não descreve mais o comportamento intencional do executor.
text = text.replace(
    '            self.assertEqual(frame.evaluate("window.__surfacePointerDown"), 0)\n',
    '            self.assertEqual(frame.evaluate("window.__surfacePointerDown"), 1)\n',
    1,
)

FILE.write_text(text, encoding="utf-8")
print(f"Playwright BUG-046 alinhado: {count} ordem(ns) recebeu(ram) resolved_monotonic_aceite; clique simples exige pointerdown real.")
