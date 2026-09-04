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


def _sanitize_error(error, limit=500):
    text = f"{type(error).__name__}: {error}"
    text = " ".join(text.replace("\r", " ").replace("\n", " ").split())
    return text[:limit]


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


def _probe_chip_dom(robo, chip, ficha):
    try:
        probe = chip.evaluate(
            """el => {
                const r = el.getBoundingClientRect();
                const cx = r.left + (r.width / 2);
                const cy = r.top + (r.height / 2);
                const hit = document.elementFromPoint(cx, cy);
                const css = getComputedStyle(el);
                return {
                    tag: String(el.tagName || '').toLowerCase(),
                    cls: String(el.className || '').slice(0, 220),
                    dataRole: String(el.getAttribute('data-role') || ''),
                    dataValue: String(el.getAttribute('data-value') || ''),
                    disabledProp: Boolean(el.disabled),
                    ariaDisabled: String(el.getAttribute('aria-disabled') || ''),
                    ariaPressed: String(el.getAttribute('aria-pressed') || ''),
                    ariaSelected: String(el.getAttribute('aria-selected') || ''),
                    dataSelected: String(el.getAttribute('data-selected') || ''),
                    dataIsSelected: String(el.getAttribute('data-is-selected') || ''),
                    dataActive: String(el.getAttribute('data-active') || ''),
                    dataState: String(el.getAttribute('data-state') || ''),
                    pointerEvents: String(css.pointerEvents || ''),
                    visibility: String(css.visibility || ''),
                    opacity: String(css.opacity || ''),
                    width: Number(r.width || 0),
                    height: Number(r.height || 0),
                    hitTag: hit ? String(hit.tagName || '').toLowerCase() : '',
                    hitClass: hit ? String(hit.className || '').slice(0, 220) : '',
                    hitDataRole: hit ? String(hit.getAttribute('data-role') || '') : '',
                    hitDataValue: hit ? String(hit.getAttribute('data-value') || '') : '',
                    selfContainsHit: Boolean(hit && (hit === el || el.contains(hit)))
                };
            }"""
        )
    except Exception as error:
        if robo.erro_driver_playwright(error):
            raise
        print(
            f"BETTING_CHIP_DOM_PROBE_ERROR value={int(ficha)} "
            f"error={_sanitize_error(error)}"
        )
        return

    print(
        "BETTING_CHIP_DOM "
        f"value={int(ficha)} "
        f"tag={probe.get('tag')!r} class={probe.get('cls')!r} "
        f"data_role={probe.get('dataRole')!r} data_value={probe.get('dataValue')!r} "
        f"disabled_prop={probe.get('disabledProp')} "
        f"aria_disabled={probe.get('ariaDisabled')!r} "
        f"aria_pressed={probe.get('ariaPressed')!r} "
        f"aria_selected={probe.get('ariaSelected')!r} "
        f"data_selected={probe.get('dataSelected')!r} "
        f"data_is_selected={probe.get('dataIsSelected')!r} "
        f"data_active={probe.get('dataActive')!r} data_state={probe.get('dataState')!r} "
        f"pointer_events={probe.get('pointerEvents')!r} "
        f"visibility={probe.get('visibility')!r} opacity={probe.get('opacity')!r} "
        f"size={probe.get('width')}x{probe.get('height')} "
        f"hit_tag={probe.get('hitTag')!r} hit_class={probe.get('hitClass')!r} "
        f"hit_data_role={probe.get('hitDataRole')!r} "
        f"hit_data_value={probe.get('hitDataValue')!r} "
        f"self_contains_hit={probe.get('selfContainsHit')}"
    )


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
                print(
                    f"BETTING_TARGET_TRIAL_ERROR target={alvo_nome} "
                    f"error={_sanitize_error(error)}"
                )

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
                selected = robo.ficha_explicitamente_selecionada(chip)
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                selected = False

            print(
                f"BETTING_CHIP_SELECTED_PROBE value={int(ficha)} "
                f"selected={str(bool(selected)).lower()}"
            )

            if selected:
                continue

            try:
                chip.click(
                    trial=True,
                    timeout=BETTING_CHIP_TRIAL_TIMEOUT_MS,
                )
            except Exception as error:
                if robo.erro_driver_playwright(error):
                    raise
                blockers.append(f"CHIP_NOT_ACTIONABLE:{int(ficha)}")
                print(
                    f"BETTING_CHIP_TRIAL_ERROR value={int(ficha)} "
                    f"error={_sanitize_error(error)}"
                )
                _probe_chip_dom(robo, chip, ficha)

    if not blockers:
        return ["NO_STATIC_BLOCKER_FOUND"]

    return list(dict.fromkeys(blockers))


def _safe_frame_url(url):
    raw = str(url or "")
    raw = raw.split("#", 1)[0]
    raw = raw.split("?", 1)[0]
    return raw[:240]


def _dump_dom_snapshot(robo, page):
    """
    Snapshot somente-leitura para descobrir mudancas de DOM/iframe da Evolution.

    Nao executa cliques nem altera estado. Limita o volume e remove query/hash
    das URLs para evitar vazar tokens de sessao no console.
    """
    try:
        frames = list(page.frames)
    except Exception as error:
        if robo.erro_driver_playwright(error):
            raise
        print(f"BETTING_DOM_SNAPSHOT_ERROR=FRAMES:{type(error).__name__}")
        return

    print(f"BETTING_DOM_FRAME_COUNT={len(frames)}")

    for index, frame in enumerate(frames[:16]):
        try:
            frame_url = _safe_frame_url(frame.url)
        except Exception:
            frame_url = ""

        try:
            frame_name = str(frame.name or "")[:120]
        except Exception:
            frame_name = ""

        print(
            f"BETTING_DOM_FRAME index={index} name={frame_name!r} url={frame_url!r}"
        )

        try:
            snapshot = frame.evaluate(
                """() => {
                    const nodes = Array.from(document.querySelectorAll(
                        '[data-role],[data-value],button,[role],iframe'
                    )).slice(0, 160);
                    return nodes.map((el) => ({
                        tag: String(el.tagName || '').toLowerCase(),
                        id: String(el.id || '').slice(0, 100),
                        cls: String(el.className || '').slice(0, 180),
                        dataRole: String(el.getAttribute('data-role') || '').slice(0, 140),
                        dataValue: String(el.getAttribute('data-value') || '').slice(0, 80),
                        role: String(el.getAttribute('role') || '').slice(0, 80),
                        ariaLabel: String(el.getAttribute('aria-label') || '').slice(0, 140),
                        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
                        visible: Boolean(el.getClientRects().length)
                    }));
                }"""
            )
        except Exception as error:
            if robo.erro_driver_playwright(error):
                raise
            print(
                f"BETTING_DOM_FRAME_SNAPSHOT_ERROR index={index} "
                f"error={type(error).__name__}"
            )
            continue

        for item_index, item in enumerate(snapshot[:160]):
            print(
                "BETTING_DOM_NODE "
                f"frame={index} node={item_index} "
                f"tag={item.get('tag')!r} id={item.get('id')!r} "
                f"class={item.get('cls')!r} data_role={item.get('dataRole')!r} "
                f"data_value={item.get('dataValue')!r} role={item.get('role')!r} "
                f"aria_label={item.get('ariaLabel')!r} "
                f"disabled={item.get('disabled')} visible={item.get('visible')}"
            )


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
        _dump_dom_snapshot(robo, page)
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
    _dump_dom_snapshot(robo, page)
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
