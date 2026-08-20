from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
text = ROBO.read_text(encoding="utf-8")
original = text

text = text.replace(
    'NOME_ATUALIZACAO = "BUG-046 Janela Real Resolved + 8s"',
    'NOME_ATUALIZACAO = "BUG-047 Fast Path Forcado Resolved + 8s"',
    1,
)

marker = '''def elemento_apostavel(locator):\n    return primeiro_elemento_apostavel(locator) is not None\n\n\n'''
helper = '''def elemento_apostavel(locator):\n    return primeiro_elemento_apostavel(locator) is not None\n\n\ndef primeiro_elemento_dom_visivel(locator, limite=32):\n    \"\"\"Retorna o primeiro elemento DOM visivel sem executar actionability/trial do Playwright.\"\"\"\n    try:\n        quantidade = min(max(0, int(locator.count())), max(1, int(limite)))\n    except Exception:\n        return None\n    for indice in range(quantidade):\n        try:\n            elemento = locator.nth(indice)\n            if elemento.is_visible():\n                return elemento\n        except Exception:\n            continue\n    return None\n\n\n'''
if marker not in text:
    raise SystemExit("marcador do helper DOM nao encontrado")
text = text.replace(marker, helper, 1)

old_target = '''        elemento = primeiro_elemento_apostavel(locator)\n        if elemento is not None:\n            elementos_alvos[alvo] = elemento\n'''
new_target = '''        # BUG-047: nao usa click(trial=True) no fast path. Presenca + visibilidade\n        # bastam para localizar o alvo; o clique financeiro real usa force=True.\n        elemento = primeiro_elemento_dom_visivel(locator)\n        if elemento is not None:\n            elementos_alvos[alvo] = elemento\n'''
if old_target not in text:
    raise SystemExit("bloco de alvo acionavel nao encontrado")
text = text.replace(old_target, new_target, 1)

old_chip_click = '''def clicar_superficie_ficha_playwright(page, elemento):\n    \"\"\"Seleciona a ficha com o clique Playwright normal usado pelo executor simples original.\"\"\"\n    try:\n        elemento.click(timeout=2000)\n        page.wait_for_timeout(150)\n        return {\"acionada\": True, \"relacao\": \"CLIQUE_PLAYWRIGHT_SIMPLES\", \"via\": \"PLAYWRIGHT_CLICK\"}\n    except Exception as erro:\n        return {\n            \"acionada\": False,\n            \"relacao\": type(erro).__name__,\n            \"motivo\": f\"falha no clique simples da ficha ({type(erro).__name__})\",\n        }\n'''
new_chip_click = '''def clicar_superficie_ficha_playwright(page, elemento):\n    \"\"\"Seleciona a ficha imediatamente no fast path, ignorando actionability do Playwright.\"\"\"\n    try:\n        elemento.click(force=True, timeout=2000)\n        page.wait_for_timeout(150)\n        return {\"acionada\": True, \"relacao\": \"CLIQUE_PLAYWRIGHT_FORCE\", \"via\": \"PLAYWRIGHT_CLICK\"}\n    except Exception as erro:\n        return {\n            \"acionada\": False,\n            \"relacao\": type(erro).__name__,\n            \"motivo\": f\"falha no clique forcado da ficha ({type(erro).__name__})\",\n        }\n'''
if old_chip_click not in text:
    raise SystemExit("helper de clique da ficha nao encontrado")
text = text.replace(old_chip_click, new_chip_click, 1)

old_wait = '''        # Após +8s, só prossegue enquanto a mesa ainda estiver numa fase pré-dados.\n        if contexto[\"estado\"] == \"ABERTA\":\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            if contexto_dom is not None:\n                decorrido_resolved_ms = (time.monotonic() - resolved_base) * 1000.0 if resolved_base > 0 else 0.0\n                if sincronizar:\n                    print(\n                        f\"⚡ Ordem {aposta.get('order_id', 'n/a')}: janela real liberada em \"\n                        f\"{decorrido_resolved_ms:.0f}ms após Resolved; stage={contexto['stage'] or 'vazio'}; \"\n                        \"DOM pronto, iniciando clique simples.\"\n                    )\n                return contexto_dom, None\n            assinatura_dom = tuple(sorted(ultimo_diagnostico.items()))\n            if sincronizar and assinatura_dom != ultima_assinatura_dom:\n                print(\n                    f\"🔎 Ordem {aposta.get('order_id', 'n/a')}: +8s atingido; aguardando DOM acionável; \"\n                    f\"{formatar_diagnostico_janela(contexto, ultimo_diagnostico)}.\"\n                )\n                ultima_assinatura_dom = assinatura_dom\n'''
new_wait = '''        # BUG-047: +8s e fase pre-dados sao a autorizacao temporal. Faz uma unica\n        # leitura do DOM sem esperar actionability/trial dos alvos. Se os elementos\n        # ainda nem existem/nao estao visiveis, falha fechado em vez de chegar atrasado.\n        if contexto[\"estado\"] == \"ABERTA\":\n            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)\n            decorrido_resolved_ms = (time.monotonic() - resolved_base) * 1000.0 if resolved_base > 0 else 0.0\n            if contexto_dom is None:\n                diagnostico_texto = formatar_diagnostico_janela(contexto, ultimo_diagnostico)\n                return None, {\n                    \"status\": \"FALHOU\",\n                    \"motivo\": (\n                        f\"+8s atingido sem todos os elementos DOM visiveis; fast path nao aguardou actionability; \"\n                        f\"{diagnostico_texto}\"\n                    ),\n                    \"cliques_alvo\": 0,\n                }\n            if sincronizar:\n                print(\n                    f\"⚡ Ordem {aposta.get('order_id', 'n/a')}: fast path liberado em \"\n                    f\"{decorrido_resolved_ms:.0f}ms após Resolved; stage={contexto['stage'] or 'vazio'}; \"\n                    \"DOM presente, clicando com force=True sem aguardar actionability.\"\n                )\n            return contexto_dom, None\n'''
if old_wait not in text:
    raise SystemExit("bloco de espera DOM do BUG-046 nao encontrado")
text = text.replace(old_wait, new_wait, 1)

old_target_click = '''def clicar_alvo_financeiro_playwright(page, elemento):\n    \"\"\"Executa o clique financeiro Playwright normal, sem force/evaluate/page.mouse.\"\"\"\n    try:\n        elemento.click(timeout=2000)\n        page.wait_for_timeout(120)\n        return {\"acionada\": True, \"relacao\": \"CLIQUE_PLAYWRIGHT_SIMPLES\"}\n    except Exception as erro:\n        return {\n            \"acionada\": False,\n            \"relacao\": type(erro).__name__,\n            \"motivo\": f\"falha no clique simples do alvo ({type(erro).__name__})\",\n        }\n'''
new_target_click = '''def clicar_alvo_financeiro_playwright(page, elemento):\n    \"\"\"Executa o clique financeiro imediato, sem actionability estrita do Playwright.\"\"\"\n    try:\n        elemento.click(force=True, timeout=2000)\n        page.wait_for_timeout(120)\n        return {\"acionada\": True, \"relacao\": \"CLIQUE_PLAYWRIGHT_FORCE\"}\n    except Exception as erro:\n        return {\n            \"acionada\": False,\n            \"relacao\": type(erro).__name__,\n            \"motivo\": f\"falha no clique forcado do alvo ({type(erro).__name__})\",\n        }\n'''
if old_target_click not in text:
    raise SystemExit("helper de clique alvo nao encontrado")
text = text.replace(old_target_click, new_target_click, 1)

text = text.replace(
    '''                alvo_elemento = primeiro_elemento_apostavel(\n                    frame_jogo.locator(f\"[data-role='{plano['seletor_alvo']}']\")\n                )''',
    '''                alvo_elemento = primeiro_elemento_dom_visivel(\n                    frame_jogo.locator(f\"[data-role='{plano['seletor_alvo']}']\")\n                )''',
    1,
)

text = text.replace(
    'f"Alvo {plano[\'alvo\']} deixou de estar acionável antes do clique"',
    'f"Alvo {plano[\'alvo\']} deixou de estar presente/visivel antes do clique"',
    1,
)

# Garantia do contrato financeiro: 2500 ms deve permanecer antes da primeira leitura.
confirm_start = text.index('def confirmar_aceite_financeiro_aposta')
confirm_end = text.index('\ndef executar_aposta_na_tela', confirm_start)
confirm_body = text[confirm_start:confirm_end]
wait_pos = confirm_body.index('page.wait_for_timeout(2500)')
read_pos = confirm_body.index('saldo_atual = ler_saldo_atual(page)')
if wait_pos >= read_pos:
    raise SystemExit("contrato 2500ms antes do saldo foi quebrado")

if text == original:
    raise SystemExit("nenhuma alteracao BUG-047 aplicada")
ROBO.write_text(text, encoding="utf-8")
print("BUG-047 aplicado: Resolved+8s + DOM sem trial + clique force=True + saldo apos 2500ms")
