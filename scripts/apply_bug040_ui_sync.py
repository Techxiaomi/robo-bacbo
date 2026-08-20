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
    'NOME_ATUALIZACAO = "BUG-039 Confirmação Financeira por Perna"',
    'NOME_ATUALIZACAO = "BUG-040 Sincronia UI e Clique Central"',
    "versão BUG-040",
)

old_aberta = '''        if contexto["estado"] == "ABERTA":\n            if aberta_detectada_em is None:\n                aberta_detectada_em = time.monotonic()\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n'''
new_aberta = '''        if contexto["estado"] == "ABERTA":\n            if aberta_detectada_em is None:\n                aberta_detectada_em = time.monotonic()\n                if sincronizar:\n                    print(\n                        f"🎞️ Ordem {aposta.get('order_id', 'n/a')}: AcceptingBets detectado; "\n                        "aguardando 1500ms para estabilização visual das fichas."\n                    )\n                # BUG-040: a Evolution anima a subida/reposicionamento das fichas\n                # no começo de AcceptingBets. Aguarda a UI estabilizar antes de\n                # qualquer tentativa de seleção de ficha ou clique financeiro.\n                page.wait_for_timeout(1500)\n                contexto_pos_animacao = avaliar_contexto_janela_aposta(aposta)\n                ultimo_contexto = contexto_pos_animacao\n                if contexto_pos_animacao["estado"] != "ABERTA":\n                    aberta_detectada_em = None\n                    continue\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n'''
text = replace_once(text, old_aberta, new_aberta, "delay AcceptingBets")

pattern_chip = re.compile(
    r'def clicar_superficie_ficha_playwright\(elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao',
    re.S,
)
new_chip = '''def clicar_superficie_ficha_playwright(elemento):
    """Clica o centro geométrico da própria ficha, sem force=True e sem subir para wrappers."""
    try:
        caixa = elemento.bounding_box()
        if not isinstance(caixa, dict):
            return {"acionada": False, "relacao": "SEM_AREA", "motivo": "ficha sem área visível"}
        largura = float(caixa.get("width") or 0.0)
        altura = float(caixa.get("height") or 0.0)
        if largura <= 0 or altura <= 0:
            return {"acionada": False, "relacao": "SEM_AREA", "motivo": "ficha sem área visível"}

        # BUG-040: o clique pertence ao elemento da ficha localizado pelo
        # data-role/data-value. O Playwright usa o centro exato da caixa e mantém
        # as checagens normais de actionability; nenhum ancestral/irmão recebe
        # clique substituto e force=True continua proibido.
        elemento.click(
            position={"x": largura / 2.0, "y": altura / 2.0},
            timeout=900,
        )
        return {"acionada": True, "relacao": "CENTRO_ELEMENTO", "via": "PLAYWRIGHT_REAL"}
    except PlaywrightTimeoutError:
        return {
            "acionada": False,
            "relacao": "TIMEOUT",
            "motivo": "centro da ficha não ficou acionável em 900ms",
        }
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha ao clicar o centro da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    if '"relacao": "CENTRO_ELEMENTO"' not in text:
        raise SystemExit(f"helper ficha: esperado 1 bloco, encontrado {count}")

old_select = '''    try:\n        elemento.click(timeout=700)\n        return {"confirmada": True, "via": "PLAYWRIGHT"}\n    except PlaywrightTimeoutError:\n        pass\n    except Exception as erro:\n        return {\n            "confirmada": False,\n            "motivo": f"falha Playwright na ficha ({type(erro).__name__})",\n        }\n\n    superficie = clicar_superficie_ficha_playwright(elemento)\n'''
new_select = '''    superficie = clicar_superficie_ficha_playwright(elemento)\n'''
text = replace_once(text, old_select, new_select, "seleção central da ficha")

old_pre = '''        try:\n            # Preparação não financeira e oportunista. Falha aqui não invalida a\n            # ordem; o caminho normal ainda pode selecionar a ficha em AcceptingBets.\n            elemento.click(timeout=300)\n            return {"confirmada": True, "ficha": ficha, "via": "PRESELECAO_PLAYWRIGHT"}\n        except Exception:\n            continue\n'''
new_pre = '''        try:\n            # Preparação não financeira e oportunista. Usa a mesma física central\n            # do caminho principal, sem force=True e sem clicar wrappers.\n            superficie = clicar_superficie_ficha_playwright(elemento)\n            if superficie.get("acionada") is True:\n                return {"confirmada": True, "ficha": ficha, "via": "PRESELECAO_CENTRO"}\n        except Exception:\n            pass\n        continue\n'''
text = replace_once(text, old_pre, new_pre, "pré-seleção central")

pattern_target = re.compile(
    r'def clicar_alvo_financeiro_playwright\(elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta',
    re.S,
)
new_target = '''def clicar_alvo_financeiro_playwright(elemento):
    """Clica o centro geométrico do próprio alvo financeiro, sem force=True ou wrappers."""
    try:
        caixa = elemento.bounding_box()
        if not isinstance(caixa, dict):
            return {"acionada": False, "relacao": "SEM_AREA", "motivo": "alvo sem área visível"}
        largura = float(caixa.get("width") or 0.0)
        altura = float(caixa.get("height") or 0.0)
        if largura <= 0 or altura <= 0:
            return {"acionada": False, "relacao": "SEM_AREA", "motivo": "alvo sem área visível"}

        # BUG-040: o elemento [data-role='bacbo-bet-spot-*'] permanece dono do
        # clique. O Playwright mira o centro e resolve apenas descendentes reais
        # desse elemento; não há fallback para ancestral, irmão ou force=True.
        elemento.click(
            position={"x": largura / 2.0, "y": altura / 2.0},
            timeout=900,
        )
        return {"acionada": True, "relacao": "CENTRO_ELEMENTO"}
    except PlaywrightTimeoutError:
        return {
            "acionada": False,
            "relacao": "TIMEOUT",
            "motivo": "centro do alvo financeiro não ficou acionável em 900ms",
        }
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha ao clicar o centro do alvo ({type(erro).__name__})",
        }


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    if 'centro geométrico do próprio alvo financeiro' not in text:
        raise SystemExit(f"helper alvo: esperado 1 bloco, encontrado {count}")

old_confirm = '''    tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n'''
new_confirm = '''    tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))\n\n    # BUG-040: depois do clique financeiro, a Evolution pode levar 1–2 s para\n    # refletir no HTML o débito já processado pelo servidor. Não lê o saldo antes\n    # dessa janela mínima para evitar classificar atualização visual tardia como\n    # "clique fantasma".\n    page.wait_for_timeout(2000)\n    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)\n'''
text = replace_once(text, old_confirm, new_confirm, "delay confirmação saldo")
ROBO.write_text(text, encoding="utf-8")

# Atualiza contrato Node: remove expectativas dos fallbacks por ancestral e fixa os novos delays/cliques centrais.
text = PURE.read_text(encoding="utf-8")
old_contract = '''    assert.match(executorPythonSource, /elementFromPoint/);\n    assert.match(executorPythonSource, /SUPERFICIE_/);\n    assert.match(executorPythonSource, /SUPERFICIE_PLAYWRIGHT_/);\n    assert.match(executorPythonSource, /hit_elemento\\.click\\(timeout=700\\)/);\n    assert.match(executorPythonSource, /preselecionar_ficha_unica_antes_da_janela/);\n    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(25\\)/);\n    assert.match(executorPythonSource, /alvo_elemento\\.click\\(timeout=750\\)/);\n    assert.doesNotMatch(executorPythonSource, /hit\\.click\\(\\)/);\n'''
new_contract = '''    assert.match(executorPythonSource, /SUPERFICIE_/);\n    assert.match(executorPythonSource, /SUPERFICIE_PLAYWRIGHT_/);\n    assert.match(executorPythonSource, /preselecionar_ficha_unica_antes_da_janela/);\n    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(25\\)/);\n    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(1500\\)/);\n    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(2000\\)/);\n    assert.match(executorPythonSource, /position=\\{\"x\": largura \\/ 2\\.0, \"y\": altura \\/ 2\\.0\\\}/);\n    assert.doesNotMatch(executorPythonSource, /alvo_elemento\\.click\\(timeout=750\\)/);\n    assert.doesNotMatch(executorPythonSource, /hit_elemento\\.click/);\n    assert.doesNotMatch(executorPythonSource, /hit\\.click\\(\\)/);\n'''
text = replace_once(text, old_contract, new_contract, "contrato Node BUG-040")
PURE.write_text(text, encoding="utf-8")

# Atualiza o contrato de fast path: a latência intencional de BUG-040 é agora parte do protocolo.
text = FAST.read_text(encoding="utf-8")
text = replace_once(
    text,
    '        self.assertIn("alvo_elemento.click(timeout=750)", corpo)\n',
    '        self.assertIn("clicar_alvo_financeiro_playwright(alvo_elemento)", corpo)\n',
    "BUG-038 clique alvo",
)
text = replace_once(
    text,
    '        self.assertIn("hit_elemento.click(timeout=700)", SOURCE)\n',
    '        self.assertIn("page.wait_for_timeout(1500)", SOURCE)\n        self.assertIn("page.wait_for_timeout(2000)", SOURCE)\n        self.assertIn(\'position={"x": largura / 2.0, "y": altura / 2.0}\', SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n',
    "BUG-038 latências novas",
)
FAST.write_text(text, encoding="utf-8")

# Os fixtures controlados passam a representar a superfície visível como DESCENDENTE
# do componente canônico, nunca como irmão/ancestral clicado por fallback.
text = DOM.read_text(encoding="utf-8")
old_chip_overlay = '''<div id="wrap">\n  <div id="chip5" data-role="chip" data-value="5">5</div>\n  <div id="surface" onpointerdown="window.__surfacePointerDown++" onclick="\n    window.__surfaceClicks++;\n    document.getElementById('chip5').classList.add('selected');\n  ">superfície</div>\n</div>'''
new_chip_overlay = '''<div id="wrap">\n  <div id="chip5" data-role="chip" data-value="5">5\n    <span id="surface" onpointerdown="window.__surfacePointerDown++" onclick="\n      window.__surfaceClicks++;\n      document.getElementById('chip5').classList.add('selected');\n    ">superfície</span>\n  </div>\n</div>'''
text = replace_once(text, old_chip_overlay, new_chip_overlay, "fixture ficha descendente")

old_roundtrip = '''<div class="wrap"><div id="chip5" class="chip" data-role="chip" data-value="5">5</div>\n  <div class="surface" onclick="escolher(5)">superfície 5</div></div>\n<div class="wrap"><div class="chip" data-role="chip" data-value="10">10</div>\n  <div class="surface" onclick="escolher(10)">superfície 10</div></div>'''
new_roundtrip = '''<div class="wrap"><div id="chip5" class="chip" data-role="chip" data-value="5">5\n  <span class="surface" onclick="escolher(5)">superfície 5</span></div></div>\n<div class="wrap"><div class="chip" data-role="chip" data-value="10">10\n  <span class="surface" onclick="escolher(10)">superfície 10</span></div></div>'''
text = replace_once(text, old_roundtrip, new_roundtrip, "fixture roundtrip descendente")

old_target_overlay = '''<div id="wrap">\n  <button id="player" data-role="bacbo-bet-spot-Player">Player</button>\n  <div id="surface" onclick="window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'; window.__surfaceClicks=(window.__surfaceClicks||0)+1">Player surface</div>\n</div>'''
new_target_overlay = '''<div id="wrap">\n  <button id="player" data-role="bacbo-bet-spot-Player">Player\n    <span id="surface" onclick="window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'; window.__surfaceClicks=(window.__surfaceClicks||0)+1">Player surface</span>\n  </button>\n</div>'''
text = replace_once(text, old_target_overlay, new_target_overlay, "fixture alvo descendente")
DOM.write_text(text, encoding="utf-8")

print("BUG-040 aplicado: 1500ms UI, 2000ms saldo e cliques centrais sem wrappers/force.")
