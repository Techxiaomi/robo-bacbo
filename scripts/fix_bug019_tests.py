from pathlib import Path
import subprocess

# Mantém calcularFichaSegura autocontida no backend porque a suíte pura extrai
# essa função isoladamente do arquivo, sem executar os requires do módulo.
bot_path = Path('robo-bacbo/bot2_coletor.js')
bot = bot_path.read_text(encoding='utf-8')
wrapper = '''function calcularFichaSegura(valorDesejado) {
    return calcularFichaSeguraProtecao(valorDesejado);
}

'''
original = '''function calcularFichaSegura(valorDesejado) {
    let valor = parseFloat(valorDesejado);
    if (isNaN(valor) || valor <= 0) return 0;

    let valorArredondado = Math.round(valor / 5) * 5;
    if (valorArredondado === 0 && valor > 0) {
        valorArredondado = 5;
    }
    return valorArredondado;
}

'''
if wrapper not in bot:
    raise RuntimeError('Wrapper calcularFichaSegura gerado nao encontrado')
bot_path.write_text(bot.replace(wrapper, original, 1), encoding='utf-8')

# O teste de intenção durável precisa reconhecer que o POST agora leva o plano composto.
order_path = Path('robo-bacbo/test/order-intent.test.js')
order = order_path.read_text(encoding='utf-8')
old_direto = 'await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto)'
new_direto = 'await enviarOrdemAoExecutor(alvoPython, valorArredondado, ordemExecutorIdDireto, planoDireto.apostas)'
old_gale = 'await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale)'
new_gale = 'await enviarOrdemAoExecutor(alvoPython, valorGale, ordemExecutorIdGale, planoGale.apostas)'
if old_direto not in order or old_gale not in order:
    raise RuntimeError('Anchors do teste de intenção durável nao encontrados')
order = order.replace(old_direto, new_direto, 1).replace(old_gale, new_gale, 1)
order_path.write_text(order, encoding='utf-8')

pure_path = Path('robo-sync-pilot/tests/test_pure_logic.py')
pure = pure_path.read_text(encoding='utf-8')
old_funcoes = '    FUNCOES = [\n        "persistir_ordens_executor",'
new_funcoes = '    FUNCOES = [\n        "normalizar_apostas_recebidas",\n        "persistir_ordens_executor",'
if old_funcoes not in pure:
    raise RuntimeError('Lista FUNCOES de idempotencia nao encontrada')
pure = pure.replace(old_funcoes, new_funcoes, 1)
start = pure.find('class Bug019CompositePayloadTests')
end = pure.find('if __name__ == "__main__":', start)
if start < 0 or end < 0:
    raise RuntimeError('Bloco BUG-019 de pure logic nao encontrado')
novo_pure = '''class Bug019CompositePayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ns = {}
        carregar_funcoes(["normalizar_apostas_recebidas"], ns)
        cls.normalizar = staticmethod(ns["normalizar_apostas_recebidas"])

    def test_normaliza_ordem_composta_principal_mais_tie(self):
        apostas = self.normalizar({"apostas": [
            {"alvo": "PlayerWon", "valor": 20},
            {"alvo": "Tie", "valor": 5}
        ]})
        self.assertEqual(apostas, [
            {"alvo": "PlayerWon", "valor": 20.0},
            {"alvo": "Tie", "valor": 5.0}
        ])

    def test_rejeita_valor_nao_representavel_e_alvo_duplicado(self):
        with self.assertRaises(ValueError):
            self.normalizar({"apostas": [{"alvo": "PlayerWon", "valor": 7}]})
        with self.assertRaises(ValueError):
            self.normalizar({"apostas": [
                {"alvo": "Tie", "valor": 5}, {"alvo": "Tie", "valor": 10}
            ]})


'''
pure = pure[:start] + novo_pure + pure[end:]
pure_path.write_text(pure, encoding='utf-8')

pw_path = Path('robo-sync-pilot/tests/test_playwright_dom.py')
pw = pw_path.read_text(encoding='utf-8')
old_name = '        "parsear_valor_monetario",\n'
new_name = '        "normalizar_apostas_recebidas",\n        "parsear_valor_monetario",\n'
if old_name not in pw:
    raise RuntimeError('Namespace de Playwright nao encontrado')
pw = pw.replace(old_name, new_name, 1)
start = pw.find('    def test_bug019_ordem_composta_prevalida_e_executa_principal_mais_tie')
end = pw.find('if __name__ == "__main__":', start)
if start < 0 or end < 0:
    raise RuntimeError('Bloco BUG-019 de Playwright nao encontrado')
teste = '''    def test_bug019_ordem_composta_prevalida_e_executa_principal_mais_tie(self):
        pagina = self.nova_pagina("/game.html")
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"apostas": [
                {"alvo": "PlayerWon", "valor": 10},
                {"alvo": "Tie", "valor": 5}
            ]})
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(resultado["cliques_alvo"], 2)
            chips = frame.evaluate("window.__chipClicks")
            alvos = frame.evaluate("window.__targetClicks")
            self.assertEqual(chips["10"], 1)
            self.assertEqual(chips["5"], 1)
            self.assertEqual(alvos["playerA"], 1)
            self.assertEqual(alvos["tie"], 1)
        finally:
            pagina.close()


'''
pw = pw[:start] + teste + pw[end:]
pw_path.write_text(pw, encoding='utf-8')

# O workflow final faz git add explícito dos arquivos principais; este teste adicional
# precisa entrar no mesmo commit gerado.
subprocess.run(['git', 'add', str(order_path)], check=True)

print('Testes BUG-019 alinhados ao harness existente')
