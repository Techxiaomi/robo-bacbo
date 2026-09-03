from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter


class BrasilDaSorteFastAdapter(BrasilDaSorteAdapter):
    """Bootstrap reativo da Brasil da Sorte, sem alterar o contrato financeiro."""

    def pre_launch(self):
        page = self._require_prepared_page()

        print("BRASIL_DA_SORTE_STAGE=HOME")
        self._navigate(page, self._home_url)
        print("BRASIL_DA_SORTE_HOME_NAVIGATED=true")
        self._dismiss_prelaunch_overlays(page)

        if self._login_button_visible(page):
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
        # Sem espera fixa inicial: tenta usar o formulario imediatamente e, se
        # ainda nao existir, abre-o e reaproveita o polling fail-closed de 250 ms.
        self._dismiss_prelaunch_overlays(page)

        username, password, root, auth_page = self._find_login_fields(page)
        if username is None or password is None:
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

        # Nao dorme 1 s aqui. A confirmacao seguinte ja faz polling de 250 ms
        # ate POST_LOGIN_CONFIRM_TIMEOUT_MS e permanece fail-closed.
        print("BRASIL_DA_SORTE_LOGIN_SUBMITTED=true")

    def _open_login_form(self, primary_page):
        self._dismiss_prelaunch_overlays(primary_page)

        direct = primary_page.locator("button", has_text=self.DIRECT_LOGIN_PATTERN)
        for index in range(min(direct.count(), 8)):
            candidate = direct.nth(index)
            try:
                if not candidate.is_visible():
                    continue
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
