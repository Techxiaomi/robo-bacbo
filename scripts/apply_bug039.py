from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
robo = root / "robo-sync-pilot" / "robo.py"
tests = root / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"

src = robo.read_text(encoding="utf-8")
txt = tests.read_text(encoding="utf-8")

src = src.replace('VERSAO_ROBO = "v1.6.12"', 'VERSAO_ROBO = "v1.6.13"', 1)
src = src.replace('NOME_ATUALIZACAO = "BUG-038 Fast Path da Janela Evolution"', 'NOME_ATUALIZACAO = "BUG-039 Confirmação Financeira por Perna"', 1)

needle = '''def confirmar_aceite_financeiro_aposta(page, saldo_antes, exposicao_esperada):\n'''
helper = r'''def clicar_alvo_financeiro_playwright(elemento):
    """Aciona a superfície real do alvo sem force=True e sem sair do componente financeiro."""
    resultado_handle = None
    hit_handle = None
    try:
        resultado_handle = elemento.evaluate_handle("""el => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { hit: null, relacao: 'SEM_AREA' };
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = el.ownerDocument.elementFromPoint(x, y);
            if (!hit) return { hit: null, relacao: 'SEM_SUPERFICIE' };

            const rectHit = hit.getBoundingClientRect();
            const estilo = getComputedStyle(hit);
            const visivel = rectHit.width > 0 && rectHit.height > 0
                && estilo.display !== 'none'
                && estilo.visibility !== 'hidden'
                && estilo.pointerEvents !== 'none';
            if (!visivel) return { hit: null, relacao: 'NAO_VISIVEL' };

            let relacao = 'EXTERNA';
            if (hit === el) relacao = 'PROPRIA';
            else if (el.contains(hit)) relacao = 'DESCENDENTE';
            else if (hit.contains(el)) relacao = 'ANCESTRAL';
            else if (el.parentElement && hit.parentElement === el.parentElement) relacao = 'MESMO_CONTAINER';

            if (relacao === 'PROPRIA' || relacao === 'DESCENDENTE') return { hit, relacao };

            // Para ancestral/irmão, exige sobreposição quase integral e que o mesmo
            // pequeno container possua exatamente um alvo financeiro. Isso evita
            // clicar em wrappers genéricos da mesa.
            if (relacao === 'ANCESTRAL' || relacao === 'MESMO_CONTAINER') {
                const pai = el.parentElement;
                const escopo = relacao === 'ANCESTRAL' ? hit : pai;
                if (!escopo) return { hit: null, relacao: 'EXTERNA' };
                const alvos = escopo.querySelectorAll("[data-role^='bacbo-bet-spot-']");
                const areaEl = Math.max(1, rect.width * rect.height);
                const areaHit = Math.max(1, rectHit.width * rectHit.height);
                const ix = Math.max(0, Math.min(rect.right, rectHit.right) - Math.max(rect.left, rectHit.left));
                const iy = Math.max(0, Math.min(rect.bottom, rectHit.bottom) - Math.max(rect.top, rectHit.top));
                const sobreposicao = (ix * iy) / areaEl;
                const razaoArea = areaHit / areaEl;
                if (alvos.length === 1 && sobreposicao >= 0.80 && razaoArea <= 1.60) {
                    return { hit, relacao };
                }
            }
            return { hit: null, relacao: 'EXTERNA' };
        }""")
        relacao_handle = resultado_handle.get_property("relacao")
        try:
            relacao = str(relacao_handle.json_value() or "DESCONHECIDA")
        finally:
            relacao_handle.dispose()
        hit_handle = resultado_handle.get_property("hit")
        hit_elemento = hit_handle.as_element()
        if hit_elemento is None:
            return {"acionada": False, "relacao": relacao, "motivo": "superfície financeira não autorizada"}
        hit_elemento.click(timeout=650)
        return {"acionada": True, "relacao": relacao}
    except Exception as erro:
        return {"acionada": False, "relacao": type(erro).__name__, "motivo": f"falha ao acionar alvo ({type(erro).__name__})"}
    finally:
        if hit_handle is not None:
            try:
                hit_handle.dispose()
            except Exception:
                pass
        if resultado_handle is not None:
            try:
                resultado_handle.dispose()
            except Exception:
                pass


'''
if needle not in src:
    raise SystemExit("BUG-039: ponto do helper financeiro nao encontrado")
src = src.replace(needle, helper + needle, 1)

src = src.replace(
    '    ultima_assinatura_dom = None\n',
    '    ultima_assinatura_dom = None\n    aberta_detectada_em = None\n',
    1,
)
src = src.replace(
    '        if contexto["estado"] == "ABERTA":\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n',
    '        if contexto["estado"] == "ABERTA":\n            if aberta_detectada_em is None:\n                aberta_detectada_em = time.monotonic()\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n',
    1,
)
src = src.replace(
    '                        f"{(time.monotonic() - inicio_espera) * 1000:.0f}ms; iniciando fast path financeiro."\n',
    '                        f"{(time.monotonic() - inicio_espera) * 1000:.0f}ms total / "\n                        f"{(time.monotonic() - aberta_detectada_em) * 1000:.0f}ms desde AcceptingBets; "\n                        f"iniciando fast path financeiro."\n',
    1,
)

src = src.replace(
    '    cliques_alvo = 0\n    ficha_corrente = None\n',
    '    cliques_alvo = 0\n    ficha_corrente = None\n    confirmacoes_financeiras = []\n',
    1,
)
src = src.replace(
    '        frame_jogo = contexto_dom["frame"]\n\n        for plano in planos:\n',
    '        frame_jogo = contexto_dom["frame"]\n        saldo_referencia = round(float(saldo_antes), 2)\n\n        for plano in planos:\n',
    1,
)

old_click = '''                        alvo_elemento.click(timeout=750)\n                        cliques_alvo += 1\n                        # O clique Playwright já conclui o ciclo de input. Uma pausa\n                        # mínima preserva o processamento do DOM sem consumir a janela.\n                        page.wait_for_timeout(20)\n'''
new_click = '''                        inicio_clique = time.monotonic()\n                        alvo_real = clicar_alvo_financeiro_playwright(alvo_elemento)\n                        if alvo_real.get("acionada") is not True:\n                            status = "AMBIGUA" if cliques_alvo > 0 else "FALHOU"\n                            return {\n                                "status": status,\n                                "motivo": (\n                                    f"Superfície financeira de {plano['alvo']} não foi autorizada: "\n                                    f"{alvo_real.get('motivo', alvo_real.get('relacao', 'motivo desconhecido'))}"\n                                ),\n                                "cliques_alvo": cliques_alvo,\n                            }\n                        cliques_alvo += 1\n\n                        # BUG-039: cada clique precisa produzir o débito da própria\n                        # ficha antes que qualquer outra perna/clique seja autorizado.\n                        confirmacao_perna = confirmar_aceite_financeiro_aposta(\n                            page, saldo_referencia, float(ficha)\n                        )\n                        confirmacao_perna["alvo"] = plano["alvo"]\n                        confirmacao_perna["ficha"] = int(ficha)\n                        confirmacao_perna["superficie"] = alvo_real.get("relacao")\n                        confirmacoes_financeiras.append(confirmacao_perna)\n                        if confirmacao_perna.get("confirmada") is not True:\n                            motivo = str(confirmacao_perna.get("motivo") or "Aceite financeiro da perna não comprovado")\n                            print(\n                                f"🚨 CLIQUE SEM ACEITE COMPROVADO: R$ {int(ficha)} {plano['alvo']}; "\n                                f"superfície={alvo_real.get('relacao', 'n/a')}; {motivo}."\n                            )\n                            return {\n                                "status": "AMBIGUA",\n                                "motivo": motivo,\n                                "cliques_alvo": cliques_alvo,\n                                "confirmacao": {\n                                    "confirmada": False,\n                                    "metodo": "SALDO_NAO_CONFIRMADO",\n                                    "saldo_antes": saldo_antes,\n                                    "saldo_depois": confirmacao_perna.get("saldo_depois"),\n                                    "exposicao_esperada": sum(p["valor"] for p in planos),\n                                    "pernas": confirmacoes_financeiras,\n                                },\n                            }\n                        saldo_referencia = round(float(confirmacao_perna["saldo_depois"]), 2)\n                        print(\n                            f"✅ PERNA ACEITA: R$ {int(ficha)} {plano['alvo']} via "\n                            f"{alvo_real.get('relacao', 'n/a')}; débito confirmado em "\n                            f"{(time.monotonic() - inicio_clique) * 1000:.0f}ms; "\n                            f"saldo R$ {confirmacao_perna['saldo_antes']:.2f} -> "\n                            f"R$ {confirmacao_perna['saldo_depois']:.2f}."\n                        )\n'''
if old_click not in src:
    raise SystemExit("BUG-039: bloco de clique financeiro nao encontrado")
src = src.replace(old_click, new_click, 1)

old_final = '''        total = sum(p["valor"] for p in planos)\n        resumo = " + ".join(f"R$ {p['valor']} {p['alvo']}" for p in planos)\n        confirmacao = confirmar_aceite_financeiro_aposta(page, saldo_antes, total)\n        if confirmacao.get("confirmada") is not True:\n            motivo = str(confirmacao.get("motivo") or "Aceite financeiro não comprovado")\n            print(\n                f"🚨 CLIQUES SEM ACEITE COMPROVADO: {resumo}; exposição esperada R$ {total}; "\n                f"{cliques_alvo} clique(s) de alvo. {motivo}."\n            )\n            return {\n                "status": "AMBIGUA",\n                "motivo": motivo,\n                "cliques_alvo": cliques_alvo,\n                "confirmacao": confirmacao,\n            }\n\n'''
new_final = '''        total = sum(p["valor"] for p in planos)\n        resumo = " + ".join(f"R$ {p['valor']} {p['alvo']}" for p in planos)\n        debito_total = round(float(saldo_antes) - float(saldo_referencia), 2)\n        if abs(debito_total - float(total)) > float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE):\n            return {\n                "status": "AMBIGUA",\n                "motivo": (\n                    f"Débito agregado R$ {debito_total:.2f} divergiu da exposição esperada R$ {float(total):.2f}"\n                ),\n                "cliques_alvo": cliques_alvo,\n                "confirmacao": {\n                    "confirmada": False,\n                    "metodo": "SALDO_NAO_CONFIRMADO",\n                    "saldo_antes": round(float(saldo_antes), 2),\n                    "saldo_depois": round(float(saldo_referencia), 2),\n                    "exposicao_esperada": float(total),\n                    "debito_observado": debito_total,\n                    "pernas": confirmacoes_financeiras,\n                },\n            }\n        confirmacao = {\n            "confirmada": True,\n            "metodo": "SALDO_DEBITADO",\n            "saldo_antes": round(float(saldo_antes), 2),\n            "saldo_depois": round(float(saldo_referencia), 2),\n            "exposicao_esperada": float(total),\n            "debito_observado": debito_total,\n            "confirmada_em": int(time.time() * 1000),\n            "pernas": confirmacoes_financeiras,\n        }\n\n'''
if old_final not in src:
    raise SystemExit("BUG-039: bloco final de confirmacao nao encontrado")
src = src.replace(old_final, new_final, 1)

# Test loader precisa incluir o novo helper.
txt = txt.replace(
    '        "clicar_superficie_ficha_playwright",\n',
    '        "clicar_superficie_ficha_playwright",\n        "clicar_alvo_financeiro_playwright",\n',
    1,
)

fixtures_marker = '\n\nclass Handler(http.server.BaseHTTPRequestHandler):\n'
fixtures = r'''

HTML["/game-target-overlay-accepted.html"] = """<!doctype html>
<html><body>
<div class="saldo-teste">R$ 1.000,00</div>
<iframe src="/game-target-overlay-accepted-frame.html"></iframe>
</body></html>"""
HTML["/game-target-overlay-accepted-frame.html"] = """<!doctype html>
<html><head><style>
#wrap { position: relative; width: 180px; height: 70px; }
#player, #surface { position:absolute; inset:0; }
#surface { z-index:2; }
</style></head><body>
<div data-role="chip" data-value="5" aria-pressed="true">5</div>
<div id="wrap">
  <button id="player" data-role="bacbo-bet-spot-Player">Player</button>
  <div id="surface" onclick="window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'; window.__surfaceClicks=(window.__surfaceClicks||0)+1">Player surface</div>
</div>
</body></html>"""

HTML["/game-composite-first-rejected.html"] = """<!doctype html>
<html><body>
<div class="saldo-teste">R$ 1.000,00</div>
<iframe src="/game-composite-first-rejected-frame.html"></iframe>
</body></html>"""
HTML["/game-composite-first-rejected-frame.html"] = """<!doctype html>
<html><body>
<script>window.__playerClicks=0; window.__tieClicks=0;</script>
<div data-role="chip" data-value="5" aria-pressed="true">5</div>
<button data-role="bacbo-bet-spot-Player" onclick="window.__playerClicks++">Player</button>
<button data-role="bacbo-bet-spot-Tie" onclick="window.__tieClicks++; window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00'">Tie</button>
</body></html>"""
'''
if fixtures_marker not in txt:
    raise SystemExit("BUG-039: marcador de fixtures nao encontrado")
txt = txt.replace(fixtures_marker, fixtures + fixtures_marker, 1)

test_marker = '    def test_bug037_aceite_so_e_executada_apos_debito_exato_do_saldo(self):\n'
new_tests = r'''    def test_bug039_superficie_real_do_alvo_confirma_debito(self):
        pagina = self.nova_pagina("/game-target-overlay-accepted.html")
        self.configurar_janela(39, "AcceptingBets", timeout=2.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174039",
                    "alvo": "PlayerWon",
                    "valor": 5,
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 39,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-target-overlay-accepted-frame" in f.url)
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(resultado["confirmacao"]["metodo"], "SALDO_DEBITADO")
            self.assertEqual(frame.evaluate("window.__surfaceClicks"), 1)
        finally:
            pagina.close()

    def test_bug039_ordem_composta_para_apos_primeira_perna_sem_debito(self):
        pagina = self.nova_pagina("/game-composite-first-rejected.html")
        self.configurar_janela(40, "AcceptingBets", timeout=2.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174040",
                    "apostas": [
                        {"alvo": "PlayerWon", "valor": 5},
                        {"alvo": "Tie", "valor": 5},
                    ],
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 40,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-composite-first-rejected-frame" in f.url)
            self.assertEqual(resultado["status"], "AMBIGUA")
            self.assertEqual(frame.evaluate("window.__playerClicks"), 1)
            self.assertEqual(frame.evaluate("window.__tieClicks"), 0)
            self.assertEqual(resultado["cliques_alvo"], 1)
        finally:
            pagina.close()

'''
if test_marker not in txt:
    raise SystemExit("BUG-039: marcador de testes BUG-037 nao encontrado")
txt = txt.replace(test_marker, new_tests + test_marker, 1)

robo.write_text(src, encoding="utf-8")
tests.write_text(txt, encoding="utf-8")
print("BUG-039 aplicado: superfície real do alvo + confirmação financeira por perna + telemetria.")
