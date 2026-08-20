from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
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
    'NOME_ATUALIZACAO = "BUG-042 Pointer Events e Confirmação 2500ms"',
    'NOME_ATUALIZACAO = "BUG-043 Limpeza de Interface"',
    "versao BUG-043",
)

anchor = '''def localizar_frame_apostavel(page, planos):\n    contexto_dom, _ = localizar_contexto_apostavel(page, planos)\n    return contexto_dom["frame"] if contexto_dom is not None else None\n\n\n'''
helper = r'''def limpar_interface_cassino(page):
    """Fecha apenas overlays conhecidos de ajuda/boas-vindas antes da execucao financeira.

    A rotina e deliberadamente conservadora: primeiro exige um marcador textual
    COMO JOGAR/HOW TO PLAY visivel; so entao procura um controle de fechamento
    dentro de um ancestral proximo daquele marcador. Assim evita clicar no X global
    da mesa/lobby por engano.
    """
    resultado = {"limpa": True, "fechados": 0, "bloqueio": None}
    contextos = [page] + list(getattr(page, "frames", []) or [])
    token_seq = 0

    script_candidato = r"""
    () => {
      const visivel = (el) => {
        if (!el || !el.isConnected) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
      };
      const normalizar = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const todos = Array.from(document.querySelectorAll('body *'));
      const marcador = todos.find((el) => {
        if (!visivel(el)) return false;
        const t = normalizar(el.textContent);
        return t === 'como jogar' || t === 'how to play';
      });
      if (!marcador) return { presente: false };

      const seletoresFortes = [
        'button[aria-label="Close" i]', '[role="button"][aria-label="Close" i]',
        'button[aria-label="Fechar" i]', '[role="button"][aria-label="Fechar" i]',
        'button[title="Close" i]', '[role="button"][title="Close" i]',
        'button[title="Fechar" i]', '[role="button"][title="Fechar" i]',
        'button[class*="close" i]', '[role="button"][class*="close" i]',
        '[data-role*="close" i]', '[data-testid*="close" i]'
      ];
      const textoFechar = new Set(['x', '×', '✕', '✖', 'close', 'fechar']);

      let raiz = marcador;
      for (let nivel = 0; nivel < 10 && raiz; nivel++, raiz = raiz.parentElement) {
        for (const seletor of seletoresFortes) {
          const candidato = Array.from(raiz.querySelectorAll(seletor)).find(visivel);
          if (candidato) {
            candidato.setAttribute('data-bacbo-modal-close-candidate', '1');
            return { presente: true, candidato: true, nivel };
          }
        }
        const genericos = Array.from(raiz.querySelectorAll('button,[role="button"]'));
        const candidatoTexto = genericos.find((el) => visivel(el) && textoFechar.has(normalizar(el.textContent)));
        if (candidatoTexto) {
          candidatoTexto.setAttribute('data-bacbo-modal-close-candidate', '1');
          return { presente: true, candidato: true, nivel };
        }
      }
      return { presente: true, candidato: false };
    }
    """

    for contexto in contextos:
        try:
            info = contexto.evaluate(script_candidato)
        except Exception:
            continue
        if not isinstance(info, dict) or not info.get("presente"):
            continue
        if not info.get("candidato"):
            resultado["limpa"] = False
            resultado["bloqueio"] = "Painel COMO JOGAR visivel sem controle de fechamento seguro identificado"
            return resultado

        token_seq += 1
        try:
            candidato = contexto.locator('[data-bacbo-modal-close-candidate="1"]').first
            candidato.click(timeout=1200)
            page.wait_for_timeout(200)
            resultado["fechados"] += 1
            with contextlib.suppress(Exception):
                contexto.evaluate("() => document.querySelectorAll('[data-bacbo-modal-close-candidate]').forEach(el => el.removeAttribute('data-bacbo-modal-close-candidate'))")
        except Exception as erro:
            resultado["limpa"] = False
            resultado["bloqueio"] = f"Painel COMO JOGAR visivel, mas fechamento falhou ({type(erro).__name__})"
            return resultado

        try:
            restante = contexto.evaluate(r"""
            () => Array.from(document.querySelectorAll('body *')).some((el) => {
              const s = getComputedStyle(el); const r = el.getBoundingClientRect();
              if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity || 1) <= 0 || r.width <= 0 || r.height <= 0) return false;
              const t = String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              return t === 'como jogar' || t === 'how to play';
            })
            """)
        except Exception:
            restante = False
        if restante:
            resultado["limpa"] = False
            resultado["bloqueio"] = "Painel COMO JOGAR permaneceu visivel apos tentativa de fechamento"
            return resultado

    return resultado


'''
text = replace_once(text, anchor, helper + anchor, "helper limpeza interface")

old_wait_start = '''    if sincronizar:\n        print(\n            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando stage AcceptingBets + DOM acionável "\n'''
new_wait_start = '''    limpeza_inicial = limpar_interface_cassino(page)\n    if limpeza_inicial.get("fechados", 0):\n        print(f"🧹 Interface limpa: {limpeza_inicial['fechados']} painel(is) de ajuda fechado(s) antes da espera da ordem.")\n    if limpeza_inicial.get("limpa") is not True:\n        return None, {\n            "status": "FALHOU",\n            "motivo": limpeza_inicial.get("bloqueio") or "Interface bloqueada por overlay/modal",\n            "cliques_alvo": 0,\n        }\n\n    if sincronizar:\n        print(\n            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando stage AcceptingBets + DOM acionável "\n'''
text = replace_once(text, old_wait_start, new_wait_start, "limpeza antes da espera")

old_after_anim = '''                if contexto_pos_animacao["estado"] != "ABERTA":\n                    aberta_detectada_em = None\n                    continue\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n'''
new_after_anim = '''                if contexto_pos_animacao["estado"] != "ABERTA":\n                    aberta_detectada_em = None\n                    continue\n                limpeza_financeira = limpar_interface_cassino(page)\n                if limpeza_financeira.get("fechados", 0):\n                    print(f"🧹 Interface limpa: {limpeza_financeira['fechados']} painel(is) fechado(s) antes do preflight financeiro.")\n                if limpeza_financeira.get("limpa") is not True:\n                    return None, {\n                        "status": "FALHOU",\n                        "motivo": limpeza_financeira.get("bloqueio") or "Interface bloqueada por overlay/modal",\n                        "cliques_alvo": 0,\n                    }\n                contexto_pos_limpeza = avaliar_contexto_janela_aposta(aposta)\n                if contexto_pos_limpeza["estado"] != "ABERTA":\n                    aberta_detectada_em = None\n                    continue\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n'''
text = replace_once(text, old_after_anim, new_after_anim, "limpeza antes do preflight")
ROBO.write_text(text, encoding="utf-8")

text = FAST.read_text(encoding="utf-8")
needle = '''        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n'''
replacement = needle + '''        self.assertIn("def limpar_interface_cassino(page):", SOURCE)\n        self.assertIn("limpeza_inicial = limpar_interface_cassino(page)", SOURCE)\n        self.assertIn("limpeza_financeira = limpar_interface_cassino(page)", SOURCE)\n'''
text = replace_once(text, needle, replacement, "contrato BUG-043")
FAST.write_text(text, encoding="utf-8")

text = DOM.read_text(encoding="utf-8")
fixture_anchor = 'HTML["/game-balance-accepted.html"] = """<!doctype html>\n'
fixture = '''HTML["/game-how-to-play.html"] = """<!doctype html>\n<html><body>\n<div id="help" role="dialog" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6)">\n  <div><strong>COMO JOGAR</strong><button aria-label="Close" onclick="document.getElementById('help').remove()">×</button></div>\n</div>\n<iframe src="/game-balance-accepted-frame.html"></iframe>\n</body></html>"""\n\n\n'''
text = replace_once(text, fixture_anchor, fixture + fixture_anchor, "fixture modal")

test_anchor = '''    def test_bug039_superficie_real_do_alvo_confirma_debito(self):\n'''
test_case = '''    def test_bug043_fecha_como_jogar_antes_do_preflight_financeiro(self):\n        pagina = self.nova_pagina("/game-how-to-play.html")\n        self.configurar_janela(43, "AcceptingBets", timeout=3.0)\n        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real\n        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real\n        try:\n            resultado = executar_aposta_na_tela(\n                pagina,\n                {\n                    "order_id": "123e4567-e89b-42d3-a456-426614174043",\n                    "alvo": "PlayerWon",\n                    "valor": 5,\n                    "sincronizar_janela": True,\n                    "coletor_seq_aceite": 43,\n                    "stage_aceite": "Resolved",\n                },\n            )\n            self.assertEqual(pagina.locator("#help").count(), 0)\n            self.assertEqual(resultado["status"], "EXECUTADA")\n        finally:\n            pagina.close()\n\n'''
text = replace_once(text, test_anchor, test_case + test_anchor, "teste BUG-043")
DOM.write_text(text, encoding="utf-8")

print("BUG-043 aplicado: fecha COMO JOGAR de forma conservadora e falha fechado se overlay persistir.")
