import os
import re
from urllib.parse import urlparse

from playwright.sync_api import Page

from adapters_py.base_adapter import BettingHouseAdapter


DEFAULT_NAVIGATION_TIMEOUT_MS = 60000
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class BrasilDaSorteAdapter(BettingHouseAdapter):
    """Navegação/autenticação da Brasil da Sorte sem qualquer clique financeiro."""

    USERNAME_SELECTORS = (
        "input[name='email']",
        "input[type='email']",
        "input[name='username']",
        "input[autocomplete='username']",
    )
    PASSWORD_SELECTORS = (
        "input[name='password']",
        "input[type='password']",
        "input[autocomplete='current-password']",
    )

    def __init__(self, browser, config, navigation_timeout_ms=DEFAULT_NAVIGATION_TIMEOUT_MS):
        super().__init__(browser)
        if not isinstance(config, dict):
            raise TypeError("BRASIL_DA_SORTE_CONFIG_INVALID")

        house = config.get("house") if isinstance(config.get("house"), dict) else {}
        table = config.get("table") if isinstance(config.get("table"), dict) else {}

        if str(house.get("adapter_key") or "").strip() != "brasil-da-sorte":
            raise ValueError("BRASIL_DA_SORTE_ADAPTER_KEY_INVALID")
        if str(table.get("table_key") or "").strip() != "bacbo_br":
            raise ValueError("BRASIL_DA_SORTE_TABLE_KEY_INVALID")

        self._home_url = self._require_url(house.get("home_url"), "BRASIL_DA_SORTE_HOME_URL_REQUIRED")
        self._game_url = self._require_url(table.get("game_url"), "BRASIL_DA_SORTE_GAME_URL_REQUIRED")
        self._username = str(house.get("username") or "").strip()
        self._password = str(house.get("password") or "")
        self._session_state_file = str(house.get("session_state_file") or "").strip()
        self._navigation_timeout_ms = int(navigation_timeout_ms)

        if self._navigation_timeout_ms <= 0:
            raise ValueError("BRASIL_DA_SORTE_INVALID_TIMEOUT")

    def prepare_session(self) -> Page:
        if self._context is not None or self._page is not None:
            raise RuntimeError("BRASIL_DA_SORTE_SESSION_ALREADY_PREPARED")

        context_options = {"user_agent": DEFAULT_USER_AGENT, "permissions": []}
        if self._session_state_file and os.path.exists(self._session_state_file):
            context_options["storage_state"] = self._session_state_file

        self._context = self._browser.new_context(**context_options)
        self._page = self._context.new_page()
        self._page.set_default_navigation_timeout(self._navigation_timeout_ms)
        self._apply_stealth(self._page)
        return self._page

    def pre_launch(self) -> Page:
        page = self._require_prepared_page()
        self._navigate(page, self._game_url)

        if self._looks_like_active_session(page):
            return page

        if not self._username or not self._password:
            raise RuntimeError("BRASIL_DA_SORTE_LOGIN_CREDENTIALS_REQUIRED")

        self._navigate(page, self._home_url)
        self._perform_login(page)
        self._navigate(page, self._game_url)
        return page

    def get_game_page(self) -> Page:
        return self._require_prepared_page()

    def _perform_login(self, page: Page) -> None:
        username = self._first_visible(page, self.USERNAME_SELECTORS)
        password = self._first_visible(page, self.PASSWORD_SELECTORS)

        if username is None or password is None:
            entrar = page.get_by_role("button", name=re.compile(r"^\s*Entrar\s*$", re.IGNORECASE))
            for index in range(min(entrar.count(), 8)):
                candidate = entrar.nth(index)
                if candidate.is_visible():
                    candidate.click()
                    page.wait_for_timeout(800)
                    break
            username = self._first_visible(page, self.USERNAME_SELECTORS)
            password = self._first_visible(page, self.PASSWORD_SELECTORS)

        if username is None or password is None:
            raise RuntimeError("BRASIL_DA_SORTE_LOGIN_FORM_NOT_FOUND")

        username.fill(self._username)
        password.fill(self._password)
        password.press("Enter")
        page.wait_for_timeout(2500)

        if self._session_state_file:
            self._context.storage_state(path=self._session_state_file)

    def _navigate(self, page: Page, url: str) -> None:
        page.goto(url, wait_until="domcontentloaded", timeout=self._navigation_timeout_ms)

    @staticmethod
    def _first_visible(page: Page, selectors):
        for selector in selectors:
            locator = page.locator(selector)
            for index in range(min(locator.count(), 8)):
                candidate = locator.nth(index)
                if candidate.is_visible():
                    return candidate
        return None

    @staticmethod
    def _looks_like_active_session(page: Page) -> bool:
        try:
            return len(page.frames) > 1
        except Exception:
            return False

    @staticmethod
    def _apply_stealth(page: Page) -> None:
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
        parsed = urlparse(normalized)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(code)
        return normalized
