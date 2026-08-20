from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

text = ROBO.read_text(encoding="utf-8")

text = text.replace(
    'NOME_ATUALIZACAO = "BUG-045 Clique Fisico via page.mouse"',
    'NOME_ATUALIZACAO = "BUG-046 Janela Real Resolved + 8s"',
    1,
)

# Timestamp monotônico do último Resolved confirmado pelo próprio coletor.
anchor = 'ultimo_tempo_rodada = 0\nCOLETOR_SESSAO = str(uuid.uuid4())\n'
replacement = 'ultimo_tempo_rodada = 0\nultimo_resolved_monotonic = 0.0\nCOLETOR_SESSAO = str(uuid.uuid4())\n'
if replacement not in text:
    if anchor not in text:
        raise SystemExit('anchor global Resolved não encontrado')
    text = text.replace(anchor, replacement, 1)

# Vincula cada ordem ao relógio do Resolved que a originou.
anchor = '    seq_contexto = max(0, int(globals().get("coletor_seq", 0) or 0))\n'
replacement = (
    '    seq_contexto = max(0, int(globals().get("coletor_seq", 0) or 0))\n'
    '    resolved_monotonic_contexto = float(globals().get("ultimo_resolved_monotonic", 0.0) or 0.0)\n'
)
if replacement not in text:
    if anchor not in text:
        raise SystemExit('anchor registrar ordem não encontrado')
    text = text.replace(anchor, replacement, 1)

anchor = '        "coletor_seq_aceite": seq_contexto,\n        "stage_aceite": stage_contexto,\n'
replacement = (
    '        "coletor_seq_aceite": seq_contexto,\n'
    '        "resolved_monotonic_aceite": resolved_monotonic_contexto,\n'
    '        "stage_aceite": stage_contexto,\n'
)
if replacement not in text:
    if anchor not in text:
        raise SystemExit('anchor payload ordem não encontrado')
    text = text.replace(anchor, replacement, 1)

# Stages liberados são apenas os pré-dados; o relógio +8s é o gate de abertura.
pattern = re.compile(r'def stage_evolution_apostavel\(stage\):\n.*?\n\ndef avaliar_contexto_janela_aposta', re.S)
new_stage = '''def stage_evolution_apostavel(stage):
    """Permite somente fases pré-dados; o instante financeiro é governado por Resolved+8s."""
    normalizado = re.sub(r"[^a-z]", "", str(stage or "").strip().lower())
    return normalizado in {"waitingforbets", "closingbets", "acceptingbets", "betting"}


def avaliar_contexto_janela_aposta'''
text, count = pattern.subn(new_stage, text, count=1)
if count != 1:
    if '"waitingforbets", "closingbets", "acceptingbets", "betting"' not in text:
        raise SystemExit(f'bloco stage: esperado 1, encontrado {count}')

# Remove o mouse "humano" e volta ao mesmo click simples que existia no executor antigo.
pattern = re.compile(r'def clique_fisico_humano\(page, elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao', re.S)
new_clicks = '''def clicar_superficie_ficha_playwright(page, elemento):
    """Seleciona a ficha com o clique Playwright normal usado pelo executor simples original."""
    try:
        elemento.click(timeout=2000)
        page.wait_for_timeout(150)
        return {"acionada": True, "relacao": "CLIQUE_PLAYWRIGHT_SIMPLES", "via": "PLAYWRIGHT_CLICK"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no clique simples da ficha ({type(erro).__name__})",
        }


def selecionar_ficha_com_confirmacao'''
text, count = pattern.subn(new_clicks, text, count=1)
if count != 1:
    # Em caso de formato intermediário, substitui helper da ficha diretamente.
    pattern2 = re.compile(r'def clicar_superficie_ficha_playwright\(page, elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao', re.S)
    text, count2 = pattern2.subn(new_clicks, text, count=1)
    if count2 != 1 and 'CLIQUE_PLAYWRIGHT_SIMPLES' not in text:
        raise SystemExit('helper ficha não localizado')

pattern = re.compile(r'def clicar_alvo_financeiro_playwright\(page, elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta', re.S)
new_target = '''def clicar_alvo_financeiro_playwright(page, elemento):
    """Executa o clique financeiro Playwright normal, sem force/evaluate/page.mouse."""
    try:
        elemento.click(timeout=2000)
        page.wait_for_timeout(120)
        return {"acionada": True, "relacao": "CLIQUE_PLAYWRIGHT_SIMPLES"}
    except Exception as erro:
        return {
            "acionada": False,
            "relacao": type(erro).__name__,
            "motivo": f"falha no clique simples do alvo ({type(erro).__name__})",
        }


def confirmar_aceite_financeiro_aposta'''
text, count = pattern.subn(new_target, text, count=1)
if count != 1:
    if text.count('CLIQUE_PLAYWRIGHT_SIMPLES') < 2:
        raise SystemExit('helper alvo não localizado')

# Reescreve o waiter: relógio mestre = Resolved + 8s; stage só impede fases financeiras inseguras.
pattern = re.compile(r'def aguardar_janela_aposta\(page, aposta, planos\):\n.*?\n\ndef clicar_alvo_financeiro_playwright', re.S)
new_waiter = '''def aguardar_janela_aposta(page, aposta, planos):
    sincronizar = aposta.get("sincronizar_janela") is True
    inicio_espera = time.monotonic()
    prazo = inicio_espera + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS
    resolved_base = float(aposta.get("resolved_monotonic_aceite") or 0.0)
    alvo_temporal = resolved_base + 8.0 if resolved_base > 0 else 0.0
    ultimo_contexto = avaliar_contexto_janela_aposta(aposta)
    ultimo_diagnostico = {}
    ultima_assinatura = None
    ultima_assinatura_dom = None

    # Mantém somente a limpeza preventiva que já se provou necessária na mesa real.
    try:
        seletor_fechar_modal = (
            'button[aria-label="Close"], '
            'button[aria-label="Fechar"], '
            '[class*="close" i]'
        )
        candidatos_fechar = page.locator(seletor_fechar_modal)
        for indice in range(min(candidatos_fechar.count(), 8)):
            fechar = candidatos_fechar.nth(indice)
            if fechar.is_visible():
                fechar.click(force=True, timeout=1200)
                page.wait_for_timeout(1000)
                print("🧹 Interface limpa: modal/overlay preventivo fechado antes da espera financeira.")
                break
    except Exception:
        pass

    if sincronizar:
        if alvo_temporal <= 0:
            return None, {
                "status": "FALHOU",
                "motivo": "Ordem sem relógio monotônico do Resolved de origem; execução bloqueada",
                "cliques_alvo": 0,
            }
        restante_ms = max(0.0, (alvo_temporal - time.monotonic()) * 1000.0)
        print(
            f"⏱️ Ordem {aposta.get('order_id', 'n/a')} sincronizada pelo Resolved: "
            f"janela real alvo em +8000ms; faltam {restante_ms:.0f}ms."
        )

    while True:
        if sincronizar and not executor_pronto.is_set():
            return None, {
                "status": "FALHOU",
                "motivo": "Executor ficou indisponível enquanto aguardava a janela de apostas",
                "cliques_alvo": 0,
            }

        contexto = avaliar_contexto_janela_aposta(aposta)
        ultimo_contexto = contexto
        assinatura = (contexto["estado"], contexto["stage"], contexto["seq_atual"])
        if sincronizar and assinatura != ultima_assinatura:
            print(
                f"🧭 Ordem {aposta.get('order_id', 'n/a')}: estado={contexto['estado']}, "
                f"stage={contexto['stage'] or 'vazio'}, seq={contexto['seq_atual']}/{contexto['seq_ordem']}."
            )
            ultima_assinatura = assinatura

        if contexto["estado"] == "SEM_CONTEXTO":
            return None, {"status": "FALHOU", "motivo": "Ordem sem contexto de rodada do coletor; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "INCONSISTENTE":
            return None, {"status": "FALHOU", "motivo": "Contexto de rodada inconsistente; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "EXPIRADA":
            return None, {"status": "EXPIRADA", "motivo": "Nova rodada foi resolvida antes da execução; ordem descartada sem cliques", "cliques_alvo": 0}

        agora = time.monotonic()
        if alvo_temporal > 0 and agora < alvo_temporal:
            page.wait_for_timeout(min(50, max(1, int((alvo_temporal - agora) * 1000))))
            continue

        # Após +8s, só prossegue enquanto a mesa ainda estiver numa fase pré-dados.
        if contexto["estado"] == "ABERTA":
            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)
            if contexto_dom is not None:
                decorrido_resolved_ms = (time.monotonic() - resolved_base) * 1000.0 if resolved_base > 0 else 0.0
                if sincronizar:
                    print(
                        f"⚡ Ordem {aposta.get('order_id', 'n/a')}: janela real liberada em "
                        f"{decorrido_resolved_ms:.0f}ms após Resolved; stage={contexto['stage'] or 'vazio'}; "
                        "DOM pronto, iniciando clique simples."
                    )
                return contexto_dom, None
            assinatura_dom = tuple(sorted(ultimo_diagnostico.items()))
            if sincronizar and assinatura_dom != ultima_assinatura_dom:
                print(
                    f"🔎 Ordem {aposta.get('order_id', 'n/a')}: +8s atingido; aguardando DOM acionável; "
                    f"{formatar_diagnostico_janela(contexto, ultimo_diagnostico)}."
                )
                ultima_assinatura_dom = assinatura_dom

        # FirstDie/SecondDie/.../Confirmation/Resolved nunca passam por estado ABERTA.
        if time.monotonic() >= prazo:
            diagnostico_texto = formatar_diagnostico_janela(ultimo_contexto, ultimo_diagnostico)
            return None, {
                "status": "EXPIRADA",
                "motivo": f"Fusível operacional atingido sem janela segura; {diagnostico_texto}",
                "cliques_alvo": 0,
            }

        page.wait_for_timeout(25)


def clicar_alvo_financeiro_playwright'''
text, count = pattern.subn(new_waiter, text, count=1)
if count != 1:
    if 'janela real alvo em +8000ms' not in text:
        raise SystemExit(f'waiter: esperado 1, encontrado {count}')

# Captura o relógio do Resolved imediatamente após a deduplicação estrutural.
text = text.replace(
    'def processar_resultado(dados):\n    global ultimo_tempo_rodada, coletor_seq\n',
    'def processar_resultado(dados):\n    global ultimo_tempo_rodada, ultimo_resolved_monotonic, coletor_seq\n',
    1,
)
anchor = '''            if resultado_resolvido_duplicado(game_info, tempo_atual):
                registrar_erro_limitado(
                    "resultado_resolved_duplicado",
                    "♻️ Frame Resolved duplicado ignorado sem consumir coletor_seq.",
                    10
                )
                return

            # Consome a sequência somente depois da deduplicação da rodada resolvida.
'''
replacement = '''            if resultado_resolvido_duplicado(game_info, tempo_atual):
                registrar_erro_limitado(
                    "resultado_resolved_duplicado",
                    "♻️ Frame Resolved duplicado ignorado sem consumir coletor_seq.",
                    10
                )
                return

            # BUG-046: este instante é o relógio mestre da próxima janela financeira.
            # A mesa real libera fichas/alvos aproximadamente 8 s após este Resolved.
            ultimo_resolved_monotonic = time.monotonic()

            # Consome a sequência somente depois da deduplicação da rodada resolvida.
'''
if replacement not in text:
    if anchor not in text:
        raise SystemExit('anchor processar Resolved não encontrado')
    text = text.replace(anchor, replacement, 1)

# Mantém rigidamente a confirmação de saldo após 2500ms.
needle = '''    page.wait_for_timeout(2500)
    prazo = time.monotonic() + float(EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS)
    ultimo_saldo = None
    ultimo_debito = None

    while time.monotonic() <= prazo:
        saldo_atual = ler_saldo_atual(page)
'''
if needle not in text:
    raise SystemExit('contrato 2500ms -> saldo não encontrado')

# Remove nomenclatura antiga do comentário.
text = text.replace('# BUG-045: depois do mouse.up financeiro, a Evolution pode levar mais de 2 s para', '# BUG-046: depois do clique financeiro simples, a Evolution pode levar mais de 2 s para', 1)

ROBO.write_text(text, encoding="utf-8")

# Ajusta contrato rápido para a arquitetura real Resolved+8s + click simples.
fast = FAST.read_text(encoding="utf-8")
fast = re.sub(
    r'        self\.assertIn\("def clique_fisico_humano\(page, elemento\):", SOURCE\).*?        self\.assertNotIn\("hit_elemento\.click", SOURCE\)\n',
    '''        self.assertNotIn("def clique_fisico_humano(page, elemento):", SOURCE)\n        self.assertNotIn("page.mouse.move", SOURCE)\n        self.assertNotIn('elemento.dispatch_event("pointerdown")', SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertEqual(SOURCE.count("elemento.click(timeout=2000)"), 2)\n        self.assertIn('"waitingforbets", "closingbets", "acceptingbets", "betting"', SOURCE)\n        self.assertIn("resolved_monotonic_aceite", SOURCE)\n        self.assertIn("alvo_temporal = resolved_base + 8.0", SOURCE)\n        self.assertIn("janela real alvo em +8000ms", SOURCE)\n        self.assertNotIn("aguardando 1500ms para estabilização visual das fichas", SOURCE)\n        self.assertNotIn("hit_elemento.click", SOURCE)\n''',
    fast,
    count=1,
    flags=re.S,
)
# Garante os contratos críticos mesmo se o bloco acima tiver mudado.
for expected in [
    'self.assertIn("alvo_temporal = resolved_base + 8.0", SOURCE)',
    'self.assertEqual(SOURCE.count("elemento.click(timeout=2000)"), 2)',
]:
    if expected not in fast:
        raise SystemExit(f'contrato de teste não atualizado: {expected}')
FAST.write_text(fast, encoding="utf-8")

print('BUG-046 aplicado: Resolved+8s, stages pré-dados, clique Playwright simples, saldo após 2500ms.')
