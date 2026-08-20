from pathlib import Path

path = Path('robo-sync-pilot/tests/test_playwright_dom.py')
text = path.read_text(encoding='utf-8')
old = '''    def test_bug039_ordem_composta_para_apos_primeira_perna_sem_debito(self):\n        pagina = self.nova_pagina("/game-composite-first-rejected.html")\n        self.configurar_janela(40, "AcceptingBets", timeout=2.0)\n        try:\n'''
new = '''    def test_bug039_ordem_composta_para_apos_primeira_perna_sem_debito(self):\n        pagina = self.nova_pagina("/game-composite-first-rejected.html")\n        self.configurar_janela(40, "AcceptingBets", timeout=2.0)\n        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real\n        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real\n        try:\n'''
if old not in text:
    if new in text:
        print('testfix ja aplicado')
    else:
        raise SystemExit('trecho BUG-039 nao encontrado')
else:
    text = text.replace(old, new, 1)
    path.write_text(text, encoding='utf-8')
    print('testfix aplicado')
