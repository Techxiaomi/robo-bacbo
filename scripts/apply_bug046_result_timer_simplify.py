from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

text = ROBO.read_text(encoding="utf-8")
text = text.replace(
    'NOME_ATUALIZACAO = "BUG-045 Clique Fisico via page.mouse"',
    'NOME_ATUALIZACAO = "BUG-046 Janela Real +8s e Clique Simples"',
    1,
)

# 1) Estado da mesa: memoriza a transicao real para Resolved em relogio monotonic.
old_state = '''estado_mesa = {\n    "stage": "",\n    "atualizado_em_ms": 0,\n    "round_id": "",\n    "round_resolvido": False,\n}\n'''
new_state = '''estado_mesa = {\n    "stage": "",\n    "atualizado_em_ms": 0,\n    "round_id": "",\n    "round_resolvido": False,\n    "resolved_em_monotonic": 0.0,\n}\n'''
if old_state in text:
    text = text.replace(old_state, new_state, 1)
elif '"resolved_em_monotonic": 0.0' not in text:
    raise SystemExit("estado_mesa anchor nao encontrado")

# 2) Vincula cada ordem ao instante do Resolved que gerou o sinal.
old_context = '''        with lock_contexto:\n            stage_contexto = str(estado_contexto.get("stage") or "")\n            round_id_contexto = str(estado_contexto.get("round_id") or "")\n            round_resolvido_contexto = bool(estado_contexto.get("round_resolvido"))\n'''
new_context = '''        with lock_contexto:\n            stage_contexto = str(estado_contexto.get("stage") or "")\n            round_id_contexto = str(estado_contexto.get("round_id") or "")\n            round_resolvido_contexto = bool(estado_contexto.get("round_resolvido"))\n            resolved_em_contexto = float(estado_contexto.get("resolved_em_monotonic") or 0.0)\n'''
if old_context in text:
    text = text.replace(old_context, new_context, 1)
else:
    raise SystemExit("contexto lock anchor nao encontrado")

old_context_else = '''        stage_contexto = str(estado_contexto.get("stage") or "") if isinstance(estado_contexto, dict) else ""\n        round_id_contexto = str(estado_contexto.get("round_id") or "") if isinstance(estado_contexto, dict) else ""\n        round_resolvido_contexto = bool(estado_contexto.get("round_resolvido")) if isinstance(estado_contexto, dict) else False\n'''
new_context_else = '''        stage_contexto = str(estado_contexto.get("stage") or "") if isinstance(estado_contexto, dict) else ""\n        round_id_contexto = str(estado_contexto.get("round_id") or "") if isinstance(estado_contexto, dict) else ""\n        round_resolvido_contexto = bool(estado_contexto.get("round_resolvido")) if isinstance(estado_contexto, dict) else False\n        resolved_em_contexto = float(estado_contexto.get("resolved_em_monotonic") or 0.0) if isinstance(estado_contexto, dict) else 0.0\n'''
if old_context_else in text:
    text = text.replace(old_context_else, new_context_else, 1)
else:
    raise SystemExit("contexto else anchor nao encontrado")

old_order = '''        "round_id_aceite": round_id_contexto,\n        "round_resolvido_aceite": round_resolvido_contexto\n'''
new_order = '''        "round_id_aceite": round_id_contexto,\n        "round_resolvido_aceite": round_resolvido_contexto,\n        "resolved_em_monotonic": resolved_em_contexto\n'''
if old_order in text:
    text = text.replace(old_order, new_order, 1)
else:
    raise SystemExit("ordem resolved anchor nao encontrado")

# 3) Marca somente a transicao para Resolved, sem reiniciar o relogio em frames duplicados.
old_update = '''    with estado_mesa_lock:\n        round_anterior = str(estado_mesa.get("round_id") or "")\n        round_anterior_resolvido = bool(estado_mesa.get("round_resolvido"))\n\n        if round_id and round_anterior and round_id != round_anterior:\n'''
new_update = '''    with estado_mesa_lock:\n        round_anterior = str(estado_mesa.get("round_id") or "")\n        round_anterior_resolvido = bool(estado_mesa.get("round_resolvido"))\n        stage_anterior = str(estado_mesa.get("stage") or "").strip()\n\n        if round_id and round_anterior and round_id != round_anterior:\n'''
if old_update in text:
    text = text.replace(old_update, new_update, 1)
else:
    raise SystemExit("update estado anchor nao encontrado")

old_resolved = '''        if stage.lower() == "resolved" and (round_id or round_anterior):\n            estado_mesa["round_resolvido"] = True\n\n        estado_mesa["stage"] = stage\n'''
new_resolved = '''        if stage.lower() == "resolved" and (round_id or round_anterior):\n            estado_mesa["round_resolvido"] = True\n            if stage_anterior.lower() != "resolved":\n                estado_mesa["resolved_em_monotonic"] = time.monotonic()\n\n        estado_mesa["stage"] = stage\n'''
if old_resolved in text:
    text = text.replace(old_resolved, new_resolved, 1)
else:
    raise SystemExit("resolved transition anchor nao encontrado")

# 4) Substitui o gate tardio de AcceptingBets por janela temporal observada: +8s apos Resolved.
pattern_eval = re.compile(r'def avaliar_contexto_janela_aposta\(aposta\):\n.*?\n\ndef primeiro_elemento_apostavel', re.S)
new_eval = '''def avaliar_contexto_janela_aposta(aposta):
    if not aposta.get("sincronizar_janela"):
        return {
            "estado": "ABERTA", "stage": "", "seq_atual": None, "seq_ordem": None,
            "round_id": "", "round_id_aceite": "", "idade_stage_ms": 0,
            "desde_resolved_ms": None,
        }

    seq_ordem = max(0, int(aposta.get("coletor_seq_aceite") or 0))
    seq_atual = max(0, int(globals().get("coletor_seq", 0) or 0))
    with estado_mesa_lock:
        stage = str(estado_mesa.get("stage") or "").strip()
        round_id = str(estado_mesa.get("round_id") or "").strip()
        atualizado_em_ms = max(0, int(estado_mesa.get("atualizado_em_ms") or 0))

    agora_ms = int(time.time() * 1000)
    idade_stage_ms = max(0, agora_ms - atualizado_em_ms) if atualizado_em_ms > 0 else None
    resolved_em = float(aposta.get("resolved_em_monotonic") or 0.0)
    desde_resolved_ms = int(max(0.0, time.monotonic() - resolved_em) * 1000) if resolved_em > 0 else None
    contexto = {
        "estado": "AGUARDAR_LIBERACAO",
        "stage": stage,
        "seq_atual": seq_atual,
        "seq_ordem": seq_ordem,
        "round_id": round_id,
        "round_id_aceite": str(aposta.get("round_id_aceite") or "").strip(),
        "idade_stage_ms": idade_stage_ms,
        "desde_resolved_ms": desde_resolved_ms,
    }

    if seq_ordem <= 0 or resolved_em <= 0:
        contexto["estado"] = "SEM_CONTEXTO"
        return contexto
    if seq_atual > seq_ordem:
        contexto["estado"] = "EXPIRADA"
        return contexto
    if seq_atual < seq_ordem:
        contexto["estado"] = "INCONSISTENTE"
        return contexto

    # A mesa real libera fichas/alvos aproximadamente 8 s apos o Resolved.
    # Nao espera AcceptingBets: nos logs reais esse stage chega muito mais tarde.
    if desde_resolved_ms is None or desde_resolved_ms < 8000:
        return contexto

    normalizado = re.sub(r"[^a-z]", "", stage.lower())
    if normalizado in {"firstdie", "seconddie", "thirddie", "fourthdie", "confirmation", "resolved"}:
        contexto["estado"] = "AGUARDAR_STAGE"
        return contexto

    # Depois de +8 s, WaitingForBets/ClosingBets/AcceptingBets/Betting podem
    # representar a janela visual aberta. A seguranca estrutural continua sendo
    # seq da rodada + bloqueio assim que os dados comecam.
    contexto["estado"] = "ABERTA"
    return contexto


def primeiro_elemento_apostavel'''
text, count = pattern_eval.subn(new_eval, text, count=1)
if count != 1:
    raise SystemExit(f"avaliar_contexto replacement falhou: {count}")

# 5) Remove delay de 1500ms e telemetria baseada em AcceptingBets; abre quando timer +8s estiver pronto.
pattern_wait = re.compile(r'def aguardar_janela_aposta\(page, aposta, planos\):\n.*?\n\ndef clicar_alvo_financeiro_playwright', re.S)
new_wait = '''def aguardar_janela_aposta(page, aposta, planos):
    sincronizar = aposta.get("sincronizar_janela") is True
    inicio_espera = time.monotonic()
    prazo = inicio_espera + EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS
    ultima_assinatura = None
    ultimo_diagnostico = {}

    # BUG-043: fecha modal/overlay antes de qualquer preflight financeiro.
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
        print(
            f"⏳ Ordem {aposta.get('order_id', 'n/a')} aguardando liberação real da mesa em +8s "
            f"após Resolved; coletor_seq={aposta.get('coletor_seq_aceite', 0)}."
        )

    while True:
        if sincronizar and not executor_pronto.is_set():
            return None, {"status": "FALHOU", "motivo": "Executor ficou indisponível enquanto aguardava a janela de apostas", "cliques_alvo": 0}

        contexto = avaliar_contexto_janela_aposta(aposta)
        assinatura = (contexto["estado"], contexto["stage"], contexto["seq_atual"], contexto.get("desde_resolved_ms"))
        assinatura_log = (contexto["estado"], contexto["stage"], contexto["seq_atual"])
        if sincronizar and assinatura_log != ultima_assinatura:
            print(
                f"🧭 Ordem {aposta.get('order_id', 'n/a')}: estado={contexto['estado']}, "
                f"stage={contexto['stage'] or 'vazio'}, seq={contexto['seq_atual']}/{contexto['seq_ordem']}, "
                f"desde_Resolved={contexto.get('desde_resolved_ms') if contexto.get('desde_resolved_ms') is not None else 'n/a'}ms."
            )
            ultima_assinatura = assinatura_log

        if contexto["estado"] == "SEM_CONTEXTO":
            return None, {"status": "FALHOU", "motivo": "Ordem sem timestamp/seq do Resolved; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "INCONSISTENTE":
            return None, {"status": "FALHOU", "motivo": "Contexto de rodada inconsistente; execução bloqueada", "cliques_alvo": 0}
        if contexto["estado"] == "EXPIRADA":
            return None, {"status": "EXPIRADA", "motivo": "Nova rodada foi resolvida antes da execução; ordem descartada sem cliques", "cliques_alvo": 0}

        if contexto["estado"] == "ABERTA":
            contexto_dom, ultimo_diagnostico = localizar_contexto_apostavel(page, planos)
            if contexto_dom is not None:
                if sincronizar:
                    print(
                        f"⚡ Ordem {aposta.get('order_id', 'n/a')}: janela real liberada em "
                        f"{contexto.get('desde_resolved_ms')}ms após Resolved; DOM pronto, executando clique simples."
                    )
                return contexto_dom, None

        if time.monotonic() >= prazo:
            return None, {
                "status": "EXPIRADA",
                "motivo": (
                    f"Fusível de {EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS:g}s atingido; "
                    f"stage={contexto.get('stage') or 'vazio'}, desde_Resolved={contexto.get('desde_resolved_ms')}ms, "
                    f"DOM={ultimo_diagnostico}"
                ),
                "cliques_alvo": 0,
            }
        page.wait_for_timeout(25)


def clicar_alvo_financeiro_playwright'''
text, count = pattern_wait.subn(new_wait, text, count=1)
if count != 1:
    raise SystemExit(f"aguardar_janela replacement falhou: {count}")

# 6) Volta ao clique simples que existia antes da cadeia de tentativas de evento.
pattern_helper = re.compile(r'def clique_fisico_humano\(page, elemento\):\n.*?\n\ndef clicar_superficie_ficha_playwright', re.S)
text, count = pattern_helper.subn('def clicar_superficie_ficha_playwright', text, count=1)
if count != 1:
    raise SystemExit(f"remocao helper mouse falhou: {count}")

pattern_chip = re.compile(r'def clicar_superficie_ficha_playwright\(page, elemento\):\n.*?\n\ndef selecionar_ficha_com_confirmacao', re.S)
new_chip = '''def clicar_superficie_ficha_playwright(page, elemento):
    """Clique Playwright simples na ficha, como no executor anterior funcional."""
    try:
        elemento.click(timeout=2000)
        page.wait_for_timeout(150)
        return {"acionada": True, "relacao": "CLIQUE_SIMPLES", "via": "PLAYWRIGHT_CLICK"}
    except Exception as erro:
        return {"acionada": False, "relacao": type(erro).__name__, "motivo": f"falha no clique simples da ficha ({type(erro).__name__})"}


def selecionar_ficha_com_confirmacao'''
text, count = pattern_chip.subn(new_chip, text, count=1)
if count != 1:
    raise SystemExit(f"chip helper replacement falhou: {count}")

pattern_target = re.compile(r'def clicar_alvo_financeiro_playwright\(page, elemento\):\n.*?\n\ndef confirmar_aceite_financeiro_aposta', re.S)
new_target = '''def clicar_alvo_financeiro_playwright(page, elemento):
    """Clique Playwright simples no alvo financeiro, sem force/evaluate/page.mouse."""
    try:
        elemento.click(timeout=2000)
        page.wait_for_timeout(120)
        return {"acionada": True, "relacao": "CLIQUE_SIMPLES"}
    except Exception as erro:
        return {"acionada": False, "relacao": type(erro).__name__, "motivo": f"falha no clique simples do alvo ({type(erro).__name__})"}


def confirmar_aceite_financeiro_aposta'''
text, count = pattern_target.subn(new_target, text, count=1)
if count != 1:
    raise SystemExit(f"target helper replacement falhou: {count}")

text = text.replace(
    '# BUG-045: depois do mouse.up financeiro, a Evolution pode levar mais de 2 s para',
    '# BUG-046: depois do clique financeiro, a Evolution pode levar mais de 2 s para',
    1,
)

ROBO.write_text(text, encoding="utf-8")

# Contrato: fixa a simplificacao e o timer real de +8s.
test = FAST.read_text(encoding="utf-8")
start = test.index('    def test_latencias_artificiais_criticas_foram_reduzidas')
end = test.index('    def test_loop_executor_polling_rapido', start)
replacement = '''    def test_bug046_janela_real_e_clique_simples(self):\n        self.assertIn('"resolved_em_monotonic": 0.0', SOURCE)\n        self.assertIn('desde_resolved_ms < 8000', SOURCE)\n        self.assertIn('aguardando liberação real da mesa em +8s', SOURCE)\n        self.assertNotIn('aguardando 1500ms para estabilização visual das fichas', SOURCE)\n        self.assertEqual(SOURCE.count('elemento.click(timeout=2000)'), 2)\n        self.assertNotIn('page.mouse.move(', SOURCE)\n        self.assertNotIn('elemento.dispatch_event(', SOURCE)\n        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)\n        self.assertIn('page.wait_for_timeout(2500)', SOURCE)\n        atraso = SOURCE.index("page.wait_for_timeout(2500)")\n        primeira_leitura = SOURCE.index("saldo_atual = ler_saldo_atual(page)", atraso)\n        self.assertLess(atraso, primeira_leitura)\n        self.assertIn('fechar.click(force=True, timeout=1200)', SOURCE)\n\n'''
test = test[:start] + replacement + test[end:]
FAST.write_text(test, encoding="utf-8")

print("BUG-046 aplicado: janela +8s apos Resolved, sem gate AcceptingBets, clique simples restaurado, saldo 2500ms preservado.")
