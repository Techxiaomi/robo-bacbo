import os

from adapters_py.base_adapter import BettingHouseAdapter


DEFAULT_NAVIGATION_TIMEOUT_MS = 60000
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class BrasilDaSorteAdapter(BettingHouseAdapter):
    """Casca Brasil da Sorte: contexto isolado, sessao, login e pre-launch."""

    def __init__(
        self,
        browser,
        game_url,
        home_url="",
        session_state_file="",
        username="",
        password="",
        username_selector="",
        password_selector="",
        submit_selector="",
        navigation_timeout_ms=DEFAULT_NAVIGATION_TIMEOUT_MS,
    ):
        super().__init__(browser)

        self._game_url = self._require_url(game_url, "BRASIL_DA_SORTE_GAME_URL_REQUIRED")
        self._home_url = str(home_url or "").strip()
        self._session_state_file = str(session_state_file or "").strip()
        self._username = str(username or "").strip()
        self._password = str(password or "")
        self._username_selector = str(username_selector or "").strip()
        self._password_selector = str(password_selector or "").strip()
        self._submit_selector = str(submit_selector or "").strip()
        self._navigation_timeout_ms = int(navigation_timeout_ms)

        if self._navigation_timeout_ms <= 0:
            raise ValueError("BRASIL_DA_SORTE_INVALID_TIMEOUT")

        self._validate_login_configuration()

    def prepare_session(self):
        if self._context is not None or self._page is not None:
            raise RuntimeError("BRASIL_DA_SORTE_SESSION_ALREADY_PREPARED")

        context_options = {
            "user_agent": DEFAULT_USER_AGENT,
            "permissions": [],
        }

        if self._session_state_file and os.path.exists(self._session_state_file):
            context_options["storage_state"] = self._session_state_file

        self._context = self._browser.new_context(**context_options)
        self._page = self._context.new_page()
        self._page.set_default_navigation_timeout(self._navigation_timeout_ms)
        self._apply_stealth(self._page)
        return self._page

    def launch_bacbo(self):
        page = self._require_prepared_page()

        page.goto(
            self._game_url,
            wait_until="domcontentloaded",
            timeout=self._navigation_timeout_ms,
        )

        if self._looks_like_active_session(page):
            return page

        if self._login_configured() and self._home_url:
            self._perform_login(page)
            page.goto(
                self._game_url,
                wait_until="domcontentloaded",
                timeout=self._navigation_timeout_ms,
            )

        return page

    def get_game_page(self):
        return self._require_prepared_page()

    def _perform_login(self, page):
        page.goto(
            self._home_url,
            wait_until="domcontentloaded",
            timeout=self._navigation_timeout_ms,
        )

        page.locator(self._username_selector).fill(self._username)
        page.locator(self._password_selector).fill(self._password)
        page.locator(self._submit_selector).click()
        page.wait_for_timeout(3000)

        if self._session_state_file:
            self._context.storage_state(path=self._session_state_file)

    def _validate_login_configuration(self):
        values = (
            self._username,
            self._password,
            self._username_selector,
            self._password_selector,
            self._submit_selector,
        )
        configured = [bool(value) for value in values]

        if any(configured) and not all(configured):
            raise ValueError("BRASIL_DA_SORTE_LOGIN_CONFIG_INCOMPLETE")

    def _login_configured(self):
        return all(
            (
                self._username,
                self._password,
                self._username_selector,
                self._password_selector,
                self._submit_selector,
            )
        )

    @staticmethod
    def _looks_like_active_session(page):
        try:
            return len(page.frames) > 1
        except Exception:
            return False

    @staticmethod
    def _apply_stealth(page):
        try:
            from playwright_stealth import stealth_sync

            stealth_sync(page)
        except Exception:
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page.add_init_script("window.navigator.chrome = { runtime: {} };")

    @staticmethod
    def _require_url(value, code):
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError(code)
        return normalized
