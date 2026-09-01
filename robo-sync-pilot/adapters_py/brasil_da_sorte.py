import os
import re

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
        navigation_timeout_ms=DEFAULT_NAVIGATION_TIMEOUT_MS,
    ):
        super().__init__(browser)

        self._game_url = self._require_url(game_url, "BRASIL_DA_SORTE_GAME_URL_REQUIRED")
        self._home_url = str(home_url or "").strip()
        self._session_state_file = str(session_state_file or "").strip()
        self._username = str(username or "").strip()
        self._password = str(password or "")
        self._navigation_timeout_ms = int(navigation_timeout_ms)

        if self._navigation_timeout_ms <= 0:
            raise ValueError("BRASIL_DA_SORTE_INVALID_TIMEOUT")

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

        if self._home_url:
            self._page.goto(
                self._home_url,
                wait_until="domcontentloaded",
                timeout=self._navigation_timeout_ms,
            )

        return self._page

    def launch_bacbo(self):
        page = self._require_prepared_page()

        page.goto(
            self._game_url,
            wait_until="domcontentloaded",
            timeout=self._navigation_timeout_ms,
        )

        if not self._looks_like_active_session(page) and self._home_url:
            self._perform_login_if_available(page)
            page.goto(
                self._game_url,
                wait_until="domcontentloaded",
                timeout=self._navigation_timeout_ms,
            )

        return page

    def get_game_page(self):
        return self._require_prepared_page()

    def _perform_login_if_available(self, page):
        if not self._username or not self._password:
            return False

        page.goto(
            self._home_url,
            wait_until="domcontentloaded",
            timeout=self._navigation_timeout_ms,
        )

        entrar = page.locator("button", has_text=re.compile(r"Entrar", re.IGNORECASE))
        for index in range(min(entrar.count(), 8)):
            candidate = entrar.nth(index)
            if candidate.is_visible():
                candidate.click(force=True)
                page.wait_for_timeout(1500)
                break

        email = page.locator("input[name='email']")
        password = page.locator("input[name='password']")

        if email.count() <= 0 or password.count() <= 0:
            return False

        email.first.fill(self._username)
        password.first.fill(self._password)

        submit = page.locator("button#legitimuz-action-send-analisys")
        if submit.count() > 0 and submit.first.is_visible():
            submit.first.click(force=True)
        else:
            password.first.press("Enter")

        page.wait_for_timeout(5000)

        if self._session_state_file:
            self._context.storage_state(path=self._session_state_file)

        return True

    def _looks_like_active_session(self, page):
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
