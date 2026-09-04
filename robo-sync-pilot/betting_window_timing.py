import time


BETTING_WINDOW_OPEN_GRACE_MS = 12000
BETTING_WINDOW_TOTAL_TIMEOUT_MS = 25000
BETTING_WINDOW_POLL_MS = 50
BETTING_CHIP_TRIAL_TIMEOUT_MS = 350


def _dismiss_inactivity_popup(robo, page):
    try:
        robo.fechar_popup_inatividade(page)
    except Exception as error:
        if robo.erro_driver_playwright(error):
            raise


def _require_connection_healthy(robo, page):
    if robo.pagina_indica_conexao_caida(page):
        raise robo.ErroExecucaoAposta(
            "Conexao da mesa indisponivel enquanto aguardava janela apostavel",
            ambigua=False,
        )


def _frame_with_actionable_chip(robo, page):
    """
    Detecta somente a abertura tecnica da janela.

    trial=True nao produz clique financeiro; apenas prova que pelo menos uma
    ficha visivel ja esta acionavel pelo Playwright. O plano completo continua
    sendo validado exclusivamente por robo.localizar_frame_aposta().
    """
    try:
        frames = list(page.frames)
    except Exception as error:
        if robo.erro_driver_playwright(error):
            raise
        return None

    for frame in frames:
        try:
            chips = frame.locator(robo.BETTING_CHIP_SELECTOR)
            count = min(max(0, int(chips.count())), 64)
        except Exception as error:
            if robo.erro_driver_playwright(error):
                raise
            continue

        for index in range(count):
            try:
                chip = chips.nth(index)
                if not chip.is_visible():
                    continue
                chip.click(
                    trial=True,
                    timeout=BETTING_CHIP_TRIAL_TIMEOUT_MS,
                )
                return frame
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                continue

    return None


def _diagnose_full_plan_blockers(robo, page, planos):
    """
    Diagnostico somente-leitura do mesmo contrato exigido pelo gate MC24.

    Nao produz clique real: usa apenas consultas DOM, trial=True e o hit-test
    ja existente. O retorno serve exclusivamente para explicar qual requisito
    impediu o plano completo de ficar acionavel no timeout.
    """
    frame = robo.localizar_frame_mesa(page)
    if frame is None:
        return ["FRAME_MESA_NOT_FOUND"]

    blockers = []

    for plano in planos:
        alvo_nome = str(plano.get("alvo") or "UNKNOWN")
        seletor = str(plano.get("seletor_alvo") or "")

        try:
            alvo = robo.primeiro_elemento_dom_visivel(
                frame.locator(f"[data-role='{seletor}']")
            )
        except Exception as error:
            if robo.erro_driver_playwright(error):
                raise
            alvo = None

        if alvo is None:
            blockers.append(f"TARGET_NOT_VISIBLE:{alvo_nome}")
        else:
            try:
                alvo.click(
                    trial=True,
                    timeout=BETTING_CHIP_TRIAL_TIMEOUT_MS,
                )
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                blockers.append(f"TARGET_NOT_ACTIONABLE:{alvo_nome}")

            try:
                ponto = robo.resolver_ponto_seguro_alvo(alvo)
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                ponto = {"ok": False}

            if not isinstance(ponto, dict) or ponto.get("ok") is not True:
                blockers.append(f"TARGET_HIT_TEST_FAILED:{alvo_nome}")

        for ficha, _ in plano.get("cliques_necessarios", []):
            try:
                chip = robo.localizar_ficha(frame, ficha)
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                chip = None

            if chip is None:
                blockers.append(f"CHIP_NOT_VISIBLE:{int(ficha)}")
                continue

            try:
                if robo.ficha_explicitamente_selecionada(chip):
                    continue
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise

            try:
                chip.click(
                    trial=True,
                    timeout=BETTING_CHIP_TRIAL_TIMEOUT_MS,
                )
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                blockers.append(f"CHIP_NOT_ACTIONABLE:{int(ficha)}")

    if not blockers:
        return ["NO_STATIC_BLOCKER_FOUND"]

    # Remove duplicatas preservando a ordem para deixar o log curto e estavel.
    return list(dict.fromkeys(blockers))


def wait_for_betting_window(robo, page, planos):
    """
    Gate temporal em duas fases para a latencia natural da Evolution.

    Fase 1: aguarda a mesa liberar pelo menos uma ficha acionavel, sem clique.
    Fase 2: preserva integralmente o gate MC24 original e exige que TODAS as
    fichas/alvos do plano estejam acionaveis antes de devolver o frame.

    O prazo total e absoluto desde a chegada ao gate; portanto a segunda fase
    nunca transforma a espera em timeout ilimitado nem reabre ordens antigas.
    """
    started = time.monotonic()
    open_deadline = started + (BETTING_WINDOW_OPEN_GRACE_MS / 1000.0)
    total_deadline = started + (BETTING_WINDOW_TOTAL_TIMEOUT_MS / 1000.0)

    while time.monotonic() <= open_deadline:
        _require_connection_healthy(robo, page)

        frame = robo.localizar_frame_aposta(page, planos)
        if frame is not None:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            print(
                "BETTING_WINDOW_FULLY_ACTIONABLE_MS="
                f"{elapsed_ms} phase=EARLY"
            )
            return frame

        if _frame_with_actionable_chip(robo, page) is not None:
            opened_ms = int((time.monotonic() - started) * 1000)
            print(f"BETTING_WINDOW_OPEN_DETECTED_MS={opened_ms}")
            break

        _dismiss_inactivity_popup(robo, page)
        page.wait_for_timeout(BETTING_WINDOW_POLL_MS)
    else:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        print(
            "BETTING_WINDOW_TIMEOUT_PHASE=OPEN "
            f"elapsed_ms={elapsed_ms} "
            f"limit_ms={BETTING_WINDOW_OPEN_GRACE_MS} "
            "reason=NO_ACTIONABLE_CHIP"
        )
        raise robo.ErroJanelaApostasTimeout(
            "JANELA_NAO_ABRIU_TIMEOUT: nenhuma ficha ficou acionavel em "
            f"{BETTING_WINDOW_OPEN_GRACE_MS}ms"
        )

    while time.monotonic() <= total_deadline:
        _require_connection_healthy(robo, page)

        frame = robo.localizar_frame_aposta(page, planos)
        if frame is not None:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            print(
                "BETTING_WINDOW_FULLY_ACTIONABLE_MS="
                f"{elapsed_ms} phase=POST_OPEN"
            )
            return frame

        _dismiss_inactivity_popup(robo, page)
        page.wait_for_timeout(BETTING_WINDOW_POLL_MS)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    blockers = _diagnose_full_plan_blockers(robo, page, planos)
    print(
        "BETTING_WINDOW_TIMEOUT_PHASE=FULL_PLAN "
        f"elapsed_ms={elapsed_ms} "
        f"limit_ms={BETTING_WINDOW_TOTAL_TIMEOUT_MS} "
        "reason=PLAN_NOT_FULLY_ACTIONABLE"
    )
    print(
        "BETTING_WINDOW_BLOCKERS="
        + ",".join(blockers)
    )
    raise robo.ErroJanelaApostasTimeout(
        "JANELA_FECHADA_TIMEOUT: plano financeiro nao ficou integralmente "
        f"acionavel em {BETTING_WINDOW_TOTAL_TIMEOUT_MS}ms"
    )


def install(robo):
    """Instala somente o controle temporal; nao altera modo financeiro."""
    robo.BETTING_WINDOW_TIMEOUT_MS = BETTING_WINDOW_TOTAL_TIMEOUT_MS

    def _wait(page, planos):
        return wait_for_betting_window(robo, page, planos)

    robo.aguardar_janela_apostas_aberta = _wait
    print(
        "BETTING_WINDOW_TIMING_INSTALLED=true "
        f"open_grace_ms={BETTING_WINDOW_OPEN_GRACE_MS} "
        f"total_timeout_ms={BETTING_WINDOW_TOTAL_TIMEOUT_MS}"
    )
