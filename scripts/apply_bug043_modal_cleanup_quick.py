from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"


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
    'NOME_ATUALIZACAO = "BUG-042 Pointer Events e Confirmação 2500ms"',
    'NOME_ATUALIZACAO = "BUG-043 Limpeza Preventiva de Modal"',
    "versao BUG-043",
)

old = '''    if sincronizar:\n        print(\n            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando stage AcceptingBets + DOM acionável "\n'''
new = '''    # BUG-043: alguns carregamentos da Evolution abrem um painel de ajuda/boas-vindas\n    # sobre a mesa. Esse overlay pode interceptar os eventos financeiros mesmo quando\n    # o DOM da ficha/alvo esta correto. A limpeza e oportunista e nao altera o fluxo\n    # quando nenhum modal estiver presente.\n    try:\n        seletor_fechar_modal = (\n            'button[aria-label="Close"], '\n            'button[aria-label="Fechar"], '\n            '[class*="close" i]'\n        )\n        candidatos_fechar = page.locator(seletor_fechar_modal)\n        for indice in range(min(candidatos_fechar.count(), 8)):\n            fechar = candidatos_fechar.nth(indice)\n            if fechar.is_visible():\n                fechar.click(force=True, timeout=1200)\n                page.wait_for_timeout(1000)\n                print("🧹 Interface limpa: modal/overlay preventivo fechado antes da espera financeira.")\n                break\n    except Exception:\n        pass\n\n    if sincronizar:\n        print(\n            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando stage AcceptingBets + DOM acionável "\n'''
text = replace_once(text, old, new, "limpeza preventiva antes da espera")
ROBO.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
needle = '''        self.assertIn("page.wait_for_timeout(2500)", SOURCE)\n'''
replacement = needle + '''        self.assertIn('button[aria-label="Close"]', SOURCE)\n        self.assertIn('button[aria-label="Fechar"]', SOURCE)\n        self.assertIn('[class*="close" i]', SOURCE)\n        self.assertIn('fechar.click(force=True, timeout=1200)', SOURCE)\n        self.assertIn('page.wait_for_timeout(1000)', SOURCE)\n'''
text = replace_once(text, needle, replacement, "contrato BUG-043")
FAST.write_text(text, encoding="utf-8")

print("BUG-043 aplicado: fechamento preventivo de modal antes da espera financeira.")
