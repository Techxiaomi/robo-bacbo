from adapters_py.brasil_da_sorte import (
    BrasilDaSorteAdapter,
    GAME_LAUNCH_SETTLE_MS,
)


class BrasilDaSorteFastAdapter(BrasilDaSorteAdapter):
    """Bootstrap reativo da Brasil da Sorte, sem alterar o contrato financeiro."""

    def pre_launch(self):
        page = self._require_prepared_page()

        print("BRASIL_DA_SORTE_STAGE=HOME")
        self._navigate(page, self._home_url)
        print("BRASIL_DA_SORTE_HOME_NAVIGATED=true")

        # Uma unica varredura de overlays na HOME. O fluxo antigo repetia esta
        # varredura em pre_launch -> _perform_login -> _open_login_form, gerando
        # varios segundos de trabalho DOM redundante em paginas com muitos roots.
        self._dismiss_prelaunch_overlays(page)
        print("BRASIL_DA_SORTE_POPUPS_CHECK_DONE=true")

        login_required = self._login_button_visible(page)
        print(
            "BRASIL_DA_SORTE_SESSION_PROBE_DONE="
            f"login_required:{str(login_required).lower()}"
        )

        if login_required:
            if not self._username or not self._password:
                raise RuntimeError("BRASIL_DA_SORTE_LOGIN_CREDENTIALS_REQUIRED")
            self._perform_login(page)
            self._wait_for_authenticated_home(page)
        else:
            print("BRASIL_DA_SORTE_SESSION_REUSED=true")

        print("BRASIL_DA_SORTE_STAGE=GAME_URL")
        self._navigate(page, self._game_url)
        self._dismiss_prelaunch_overlays(page)
        print(f"BRASIL_DA_SORTE_GAME_NAVIGATED_URL={page.url}")
        print(f"BRASIL_DA_SORTE_TABLE_KEY={self._table_key}")

        self._wait_and_launch_game(page)
        return page

    def _perform_login(self, page):
        # pre_launch ja provou que o botao Entrar esta visivel. Nao repete
        # dismiss de overlays nem faz uma varredura completa por campos antes
        # de abrir o formulario. Abre imediatamente e usa o polling fail-closed
        # existente de 250 ms para aguardar os campos.
        triggered = self._open_login_form(page)
        print(f"BRASIL_DA_SORTE_LOGIN_TRIGGER_RESULT={str(triggered).lower()}")
        username, password, root, auth_page = self._wait_for_login_fields(page)

        if username is None or password is None:
            self._log_login_dom_diagnostic(page)
            raise RuntimeError("BRASIL_DA_SORTE_LOGIN_FORM_NOT_FOUND")

        print("BRASIL_DA_SORTE_LOGIN_FORM_READY=true")
        username.fill(self._username)
        password.fill(self._password)

        submit = self._first_visible_role_button(root, self.LOGIN_BUTTON_PATTERN)
        if submit is not None:
            submit.click(force=True, timeout=3000)
        else:
            password.press("Enter")

        # A confirmacao seguinte ja faz polling de 250 ms ate
        # POST_LOGIN_CONFIRM_TIMEOUT_MS e permanece fail-closed.
        print("BRASIL_DA_SORTE_LOGIN_SUBMITTED=true")

    def _open_login_form(self, primary_page):
        # Sem nova varredura de overlays: pre_launch acabou de executa-la.
        # Prioriza o botao direto no documento principal, que e o caminho
        # observado em producao; so cai para pages/roots se necessario.
        direct = primary_page.locator("button", has_text=self.DIRECT_LOGIN_PATTERN)
        for index in range(min(direct.count(), 8)):
            candidate = direct.nth(index)
            try:
                if not candidate.is_visible():
                    continue
                print("BRASIL_DA_SORTE_LOGIN_BUTTON_FOUND=PRIMARY_DIRECT")
                candidate.click(force=True, timeout=3000)
                print("BRASIL_DA_SORTE_LOGIN_TRIGGERED=true")
                print("BRASIL_DA_SORTE_LOGIN_FORM_OPENED=true")
                return True
            except Exception as error:
                print(
                    "BRASIL_DA_SORTE_LOGIN_TRIGGER_ERROR="
                    f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                )

        for candidate_page in self._candidate_pages(primary_page):
            for root in self._roots(candidate_page):
                button = self._first_visible_role_button(root, self.LOGIN_BUTTON_PATTERN)
                if button is None:
                    continue
                try:
                    print("BRASIL_DA_SORTE_LOGIN_BUTTON_FOUND=ROLE_FALLBACK")
                    button.click(force=True, timeout=3000)
                    print("BRASIL_DA_SORTE_LOGIN_TRIGGERED=true")
                    print("BRASIL_DA_SORTE_LOGIN_FORM_OPENED=true")
                    return True
                except Exception as error:
                    print(
                        "BRASIL_DA_SORTE_LOGIN_TRIGGER_ERROR="
                        f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                    )

        return False

    def _wait_and_launch_game(self, primary_page):
        elapsed = 0
        interval_ms = 250

        while elapsed < self._play_button_wait_ms():
            self._dismiss_prelaunch_overlays(primary_page)

            if not self._is_expected_game_route(primary_page.url):
                print(
                    "BRASIL_DA_SORTE_GAME_ROUTE_MISMATCH="
                    f"{self._sanitize_diagnostic(primary_page.url)}"
                )
                raise RuntimeError("BRASIL_DA_SORTE_UNEXPECTED_GAME_ROUTE")

            evidence = self._game_launch_evidence(primary_page)
            if evidence["ready"]:
                candidate = evidence["control"]
                print("BRASIL_DA_SORTE_PLAY_EVIDENCE=ROUTE_TITLE_PROMPT_UNIQUE_SPAN")
                print("BRASIL_DA_SORTE_PLAY_SELECTOR=SPAN_INLINE_FLEX")
                try:
                    # O candidato ja foi provado unico e visivel. Com force=True,
                    # scroll_into_view_if_needed e redundante e em producao chegou
                    # a consumir praticamente todo o timeout de 3 s.
                    candidate.click(force=True, timeout=3000)
                    print("BRASIL_DA_SORTE_PLAY_CLICK_METHOD=PLAYWRIGHT_SPAN")
                except Exception as error:
                    print(
                        "BRASIL_DA_SORTE_PLAY_PRIMARY_CLICK_ERROR="
                        f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                    )
                    try:
                        candidate.evaluate("element => element.click()")
                        print("BRASIL_DA_SORTE_PLAY_CLICK_METHOD=DOM_SPAN")
                    except Exception as dom_error:
                        print(
                            "BRASIL_DA_SORTE_PLAY_TRIGGER_ERROR="
                            f"{self._sanitize_diagnostic(type(dom_error).__name__ + ': ' + str(dom_error))}"
                        )
                        primary_page.wait_for_timeout(interval_ms)
                        elapsed += interval_ms
                        continue

                self._wait_for_game_transition(primary_page)

                if self._is_other_game_route(primary_page.url):
                    print(
                        "BRASIL_DA_SORTE_UNEXPECTED_GAME_REDIRECT="
                        f"{self._sanitize_diagnostic(primary_page.url)}"
                    )
                    raise RuntimeError("BRASIL_DA_SORTE_UNEXPECTED_GAME_REDIRECT")

                print("BRASIL_DA_SORTE_PLAY_TRIGGERED=true")
                return

            primary_page.wait_for_timeout(interval_ms)
            elapsed += interval_ms

        evidence = self._game_launch_evidence(primary_page)
        print(f"BRASIL_DA_SORTE_PLAY_EVIDENCE_TITLE={str(evidence['title']).lower()}")
        print(f"BRASIL_DA_SORTE_PLAY_EVIDENCE_PROMPT={str(evidence['prompt']).lower()}")
        print(f"BRASIL_DA_SORTE_PLAY_EVIDENCE_SPAN_COUNT={evidence['control_count']}")
        self._log_game_dom_diagnostic(primary_page)
        print("BRASIL_DA_SORTE_PLAY_TRIGGERED=false")
        raise RuntimeError("BRASIL_DA_SORTE_PLAY_SPAN_NOT_PROVEN")

    def _play_button_wait_ms(self):
        # Mantem o timeout da classe-base sem duplicar a politica em outro modulo.
        from adapters_py.brasil_da_sorte import PLAY_BUTTON_WAIT_MS
        return PLAY_BUTTON_WAIT_MS

    def _game_transition_visible(self, primary_page):
        # Evidencia nao-financeira de que o clique iniciou a Evolution. O health
        # check final da live_bridge continua sendo a autoridade fail-closed.
        try:
            for frame in list(primary_page.frames):
                if frame == primary_page.main_frame:
                    continue
                url = str(frame.url or "").lower()
                if any(marker in url for marker in ("evolution", "evocdn", "game")):
                    return True
        except Exception:
            pass

        try:
            return primary_page.locator(
                "iframe[src*='evolution' i], iframe[src*='evocdn' i], iframe[src*='game' i]"
            ).count() > 0
        except Exception:
            return False

    def _wait_for_game_transition(self, primary_page):
        elapsed = 0
        interval_ms = 100

        while elapsed < GAME_LAUNCH_SETTLE_MS:
            if self._game_transition_visible(primary_page):
                print(f"BRASIL_DA_SORTE_PLAY_TRANSITION_READY_MS={elapsed}")
                return True
            primary_page.wait_for_timeout(interval_ms)
            elapsed += interval_ms

        print(f"BRASIL_DA_SORTE_PLAY_TRANSITION_WAIT_EXHAUSTED_MS={elapsed}")
        return False
