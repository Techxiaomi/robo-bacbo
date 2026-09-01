import os
import re
from urllib.parse import urlparse

from playwright.sync_api import Page

from adapters_py.base_adapter import BettingHouseAdapter


DEFAULT_NAVIGATION_TIMEOUT_MS = 60000
LOGIN_FORM_WAIT_MS = 10000
POST_LOGIN_CONFIRM_TIMEOUT_MS = 15000
PLAY_BUTTON_WAIT_MS = 20000
GAME_LAUNCH_SETTLE_MS = 2500
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class BrasilDaSorteAdapter(BettingHouseAdapter):
    """Navegacao/autenticacao da Brasil da Sorte sem qualquer clique financeiro."""

    USERNAME_SELECTORS = (
        "input[name='email']",
        "input[type='email']",
        "input[name='username']",
        "input[name='login']",
        "input[autocomplete='username']",
        "input[autocomplete='email']",
        "input[autocomplete='tel']",
        "input[type='tel']",
        "input[placeholder*='email' i]",
        "input[placeholder*='e-mail' i]",
        "input[placeholder*='cpf' i]",
        "input[placeholder*='telefone' i]",
        "input[placeholder*='celular' i]",
    )
    PASSWORD_SELECTORS = (
        "input[name='password']",
        "input[type='password']",
        "input[autocomplete='current-password']",
        "input[placeholder*='senha' i]",
    )
    LOGIN_BUTTON_PATTERN = re.compile(
        r"^\s*(entrar|acessar|login|iniciar\s+sess[aã]o)\s*$",
        re.IGNORECASE,
    )
    DIRECT_LOGIN_PATTERN = re.compile(r"Entrar", re.IGNORECASE)
    PLAY_BUTTON_PATTERN = re.compile(r"^\s*(jogue|jogar)\s*$", re.IGNORECASE)
    GAME_TITLE_PATTERN = re.compile(r"^\s*Bac\s+Bo(?:\s+Ao\s+Vivo)?\s*$", re.IGNORECASE)
    COOKIE_PATTERN = re.compile(r"Aceitar todos", re.IGNORECASE)
    AGE_CONFIRM_PATTERN = re.compile(r"^\s*Sim\s*$", re.IGNORECASE)

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

        self._home_url = self._require_url(
            house.get("home_url"),
            "BRASIL_DA_SORTE_HOME_URL_REQUIRED",
        )
        self._game_url = self._require_url(
            table.get("game_url"),
            "BRASIL_DA_SORTE_GAME_URL_REQUIRED",
        )
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

        print("BRASIL_DA_SORTE_STAGE=HOME")
        self._navigate(page, self._home_url)
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

        self._wait_and_launch_game(page)
        return page

    def get_game_page(self) -> Page:
        return self._require_prepared_page()

    def _perform_login(self, page: Page) -> None:
        page.wait_for_timeout(1000)
        self._dismiss_prelaunch_overlays(page)

        username, password, root, auth_page = self._find_login_fields(page)
        if username is None or password is None:
            triggered = self._open_login_form(page)
            print(f"BRASIL_DA_SORTE_LOGIN_TRIGGER_RESULT={str(triggered).lower()}")
            username, password, root, auth_page = self._wait_for_login_fields(page)

        if username is None or password is None:
            self._log_login_dom_diagnostic(page)
            raise RuntimeError("BRASIL_DA_SORTE_LOGIN_FORM_NOT_FOUND")

        username.fill(self._username)
        password.fill(self._password)

        submit = self._first_visible_role_button(root, self.LOGIN_BUTTON_PATTERN)
        if submit is not None:
            submit.click(force=True, timeout=3000)
        else:
            password.press("Enter")

        auth_page.wait_for_timeout(1000)
        print("BRASIL_DA_SORTE_LOGIN_SUBMITTED=true")

    def _wait_for_authenticated_home(self, page: Page) -> None:
        elapsed = 0
        interval_ms = 250

        while elapsed < POST_LOGIN_CONFIRM_TIMEOUT_MS:
            self._dismiss_prelaunch_overlays(page)
            if not self._login_button_visible(page):
                print("BRASIL_DA_SORTE_LOGIN_CONFIRMED=true")
                if self._session_state_file:
                    self._context.storage_state(path=self._session_state_file)
                return
            page.wait_for_timeout(interval_ms)
            elapsed += interval_ms

        raise RuntimeError("BRASIL_DA_SORTE_LOGIN_NOT_CONFIRMED")

    def _wait_and_launch_game(self, primary_page: Page) -> None:
        elapsed = 0
        interval_ms = 250

        while elapsed < PLAY_BUTTON_WAIT_MS:
            self._dismiss_prelaunch_overlays(primary_page)

            if not self._is_expected_game_route(primary_page.url):
                print(
                    "BRASIL_DA_SORTE_GAME_ROUTE_MISMATCH="
                    f"{self._sanitize_diagnostic(primary_page.url)}"
                )
                raise RuntimeError("BRASIL_DA_SORTE_UNEXPECTED_GAME_ROUTE")

            candidate = self._find_scoped_play_control(primary_page)
            if candidate is not None:
                try:
                    print("BRASIL_DA_SORTE_PLAY_SCOPE=BAC_BO")
                    candidate.click(force=True, timeout=3000)
                    primary_page.wait_for_timeout(GAME_LAUNCH_SETTLE_MS)

                    if self._is_other_game_route(primary_page.url):
                        print(
                            "BRASIL_DA_SORTE_UNEXPECTED_GAME_REDIRECT="
                            f"{self._sanitize_diagnostic(primary_page.url)}"
                        )
                        raise RuntimeError("BRASIL_DA_SORTE_UNEXPECTED_GAME_REDIRECT")

                    print("BRASIL_DA_SORTE_PLAY_TRIGGERED=true")
                    return
                except RuntimeError:
                    raise
                except Exception as error:
                    print(
                        "BRASIL_DA_SORTE_PLAY_TRIGGER_ERROR="
                        f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                    )

            primary_page.wait_for_timeout(interval_ms)
            elapsed += interval_ms

        self._log_game_dom_diagnostic(primary_page)
        print("BRASIL_DA_SORTE_PLAY_TRIGGERED=false")
        raise RuntimeError("BRASIL_DA_SORTE_SCOPED_PLAY_BUTTON_NOT_FOUND")

    def _find_scoped_play_control(self, primary_page: Page):
        # Nunca aceita um "Jogue" global. O controle precisa estar em um
        # ancestral do titulo Bac Bo/Bac Bo Ao Vivo, evitando cards relacionados.
        for candidate_page in self._candidate_pages(primary_page):
            for root in self._roots(candidate_page):
                titles = root.get_by_text(self.GAME_TITLE_PATTERN, exact=True)
                for title_index in range(min(titles.count(), 8)):
                    title = titles.nth(title_index)
                    try:
                        if not title.is_visible():
                            continue
                    except Exception:
                        continue

                    for depth in range(1, 9):
                        try:
                            scope = title.locator(f"xpath=ancestor::*[{depth}]")
                            if scope.count() <= 0:
                                continue
                            play = self._play_control_inside(scope.first)
                            if play is not None:
                                return play
                        except Exception:
                            continue

        return None

    def _play_control_inside(self, scope):
        candidates = []

        role_button = scope.get_by_role("button", name=self.PLAY_BUTTON_PATTERN)
        for index in range(min(role_button.count(), 8)):
            candidate = role_button.nth(index)
            try:
                if candidate.is_visible():
                    candidates.append(candidate)
            except Exception:
                continue

        for selector in ("button", "[role='button']", "a"):
            locator = scope.locator(selector, has_text=self.PLAY_BUTTON_PATTERN)
            for index in range(min(locator.count(), 8)):
                candidate = locator.nth(index)
                try:
                    if candidate.is_visible() and all(candidate != item for item in candidates):
                        candidates.append(candidate)
                except Exception:
                    continue

        if len(candidates) == 1:
            return candidates[0]
        return None

    def _is_expected_game_route(self, url: str) -> bool:
        return self._normalized_route(url) == self._normalized_route(self._game_url)

    def _is_other_game_route(self, url: str) -> bool:
        current = self._normalized_route(url)
        expected = self._normalized_route(self._game_url)
        return current[0:2] == expected[0:2] and current[2].startswith("/play/") and current != expected

    @staticmethod
    def _normalized_route(url: str):
        parsed = urlparse(str(url or ""))
        return (
            (parsed.scheme or "").lower(),
            (parsed.netloc or "").lower(),
            (parsed.path or "/").rstrip("/") or "/",
        )

    def _dismiss_prelaunch_overlays(self, primary_page: Page) -> None:
        for label, pattern in (
            ("COOKIE", self.COOKIE_PATTERN),
            ("AGE_CONFIRMATION", self.AGE_CONFIRM_PATTERN),
        ):
            closed = False
            for candidate_page in self._candidate_pages(primary_page):
                for root in self._roots(candidate_page):
                    locator = root.locator("button", has_text=pattern)
                    for index in range(min(locator.count(), 8)):
                        candidate = locator.nth(index)
                        try:
                            if not candidate.is_visible():
                                continue
                            candidate.click(force=True, timeout=3000)
                            candidate_page.wait_for_timeout(500)
                            print(f"BRASIL_DA_SORTE_POPUP_CLOSED={label}")
                            closed = True
                            break
                        except Exception:
                            continue
                    if closed:
                        break
                if closed:
                    break

    def _find_login_fields(self, primary_page: Page):
        for candidate_page in self._candidate_pages(primary_page):
            for root in self._roots(candidate_page):
                username = self._first_visible(root, self.USERNAME_SELECTORS)
                password = self._first_visible(root, self.PASSWORD_SELECTORS)

                if username is None and password is not None:
                    username = self._first_visible_text_input(root)

                if username is not None and password is not None:
                    return username, password, root, candidate_page

        return None, None, None, primary_page

    def _wait_for_login_fields(self, primary_page: Page):
        elapsed = 0
        interval_ms = 250

        while elapsed < LOGIN_FORM_WAIT_MS:
            username, password, root, auth_page = self._find_login_fields(primary_page)
            if username is not None and password is not None:
                return username, password, root, auth_page
            primary_page.wait_for_timeout(interval_ms)
            elapsed += interval_ms

        return None, None, None, primary_page

    def _open_login_form(self, primary_page: Page) -> bool:
        self._dismiss_prelaunch_overlays(primary_page)

        direct = primary_page.locator("button", has_text=self.DIRECT_LOGIN_PATTERN)
        for index in range(min(direct.count(), 8)):
            candidate = direct.nth(index)
            try:
                if not candidate.is_visible():
                    continue
                candidate.click(force=True, timeout=3000)
                primary_page.wait_for_timeout(2500)
                print("BRASIL_DA_SORTE_LOGIN_TRIGGERED=true")
                return True
            except Exception as error:
                print(
                    "BRASIL_DA_SORTE_LOGIN_TRIGGER_ERROR="
                    f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                )

        for candidate_page in self._candidate_pages(primary_page):
            for root in self._roots(candidate_page):
                button = self._first_visible_role_button(root, self.LOGIN_BUTTON_PATTERN)
                if button is not None:
                    try:
                        button.click(force=True, timeout=3000)
                        candidate_page.wait_for_timeout(2500)
                        print("BRASIL_DA_SORTE_LOGIN_TRIGGERED=true")
                        return True
                    except Exception as error:
                        print(
                            "BRASIL_DA_SORTE_LOGIN_TRIGGER_ERROR="
                            f"{self._sanitize_diagnostic(type(error).__name__ + ': ' + str(error))}"
                        )

        return False

    def _login_button_visible(self, page: Page) -> bool:
        locator = page.locator("button", has_text=self.DIRECT_LOGIN_PATTERN)
        for index in range(min(locator.count(), 8)):
            try:
                if locator.nth(index).is_visible():
                    return True
            except Exception:
                continue
        return False

    def _log_login_dom_diagnostic(self, primary_page: Page) -> None:
        pages = self._candidate_pages(primary_page)
        page_urls = [self._sanitize_diagnostic(item.url) for item in pages]
        print(f"BRASIL_DA_SORTE_LOGIN_DIAG_PAGES={page_urls[:8]}")

        descriptors = []
        buttons = []
        frame_urls = []

        for candidate_page in pages:
            for root in self._roots(candidate_page):
                try:
                    clean_url = self._sanitize_diagnostic(getattr(root, "url", ""))
                    if clean_url and clean_url not in frame_urls:
                        frame_urls.append(clean_url)
                except Exception:
                    pass

                inputs = root.locator("input")
                for index in range(min(inputs.count(), 20)):
                    candidate = inputs.nth(index)
                    try:
                        if not candidate.is_visible():
                            continue
                        descriptor = {
                            "type": candidate.get_attribute("type") or "",
                            "name": candidate.get_attribute("name") or "",
                            "id": candidate.get_attribute("id") or "",
                            "placeholder": candidate.get_attribute("placeholder") or "",
                            "autocomplete": candidate.get_attribute("autocomplete") or "",
                        }
                        encoded = ",".join(
                            f"{key}={self._sanitize_diagnostic(value)}"
                            for key, value in descriptor.items()
                        )
                        if encoded not in descriptors:
                            descriptors.append(encoded)
                    except Exception:
                        continue

                role_buttons = root.get_by_role("button")
                for index in range(min(role_buttons.count(), 20)):
                    candidate = role_buttons.nth(index)
                    try:
                        if not candidate.is_visible():
                            continue
                        text = self._sanitize_diagnostic(candidate.inner_text())
                        if text and text not in buttons:
                            buttons.append(text)
                    except Exception:
                        continue

        print(f"BRASIL_DA_SORTE_LOGIN_DIAG_FRAMES={frame_urls[:12]}")
        print(f"BRASIL_DA_SORTE_LOGIN_DIAG_INPUTS={descriptors[:12]}")
        print(f"BRASIL_DA_SORTE_LOGIN_DIAG_BUTTONS={buttons[:12]}")

    def _log_game_dom_diagnostic(self, primary_page: Page) -> None:
        pages = self._candidate_pages(primary_page)
        page_urls = [self._sanitize_diagnostic(item.url) for item in pages]
        frame_urls = []
        texts = []
        titles = []

        for candidate_page in pages:
            for root in self._roots(candidate_page):
                try:
                    clean_url = self._sanitize_diagnostic(getattr(root, "url", ""))
                    if clean_url and clean_url not in frame_urls:
                        frame_urls.append(clean_url)
                except Exception:
                    pass

                for selector in ("h1", "h2", "h3", "h4", "[role='heading']"):
                    locator = root.locator(selector)
                    for index in range(min(locator.count(), 20)):
                        candidate = locator.nth(index)
                        try:
                            if not candidate.is_visible():
                                continue
                            text = self._sanitize_diagnostic(candidate.inner_text())
                            if text and text not in titles:
                                titles.append(text)
                        except Exception:
                            continue

                for selector in ("button", "[role='button']", "a"):
                    locator = root.locator(selector)
                    for index in range(min(locator.count(), 30)):
                        candidate = locator.nth(index)
                        try:
                            if not candidate.is_visible():
                                continue
                            text = self._sanitize_diagnostic(candidate.inner_text())
                            if text and text not in texts:
                                texts.append(text)
                        except Exception:
                            continue

        print(f"BRASIL_DA_SORTE_GAME_DIAG_PAGES={page_urls[:8]}")
        print(f"BRASIL_DA_SORTE_GAME_DIAG_FRAMES={frame_urls[:12]}")
        print(f"BRASIL_DA_SORTE_GAME_DIAG_TITLES={titles[:20]}")
        print(f"BRASIL_DA_SORTE_GAME_DIAG_CONTROLS={texts[:20]}")

    def _candidate_pages(self, primary_page: Page):
        pages = []
        seen = set()

        for candidate in [primary_page, *list(self._context.pages)]:
            try:
                if candidate is None or candidate.is_closed():
                    continue
            except Exception:
                continue

            identity = id(candidate)
            if identity in seen:
                continue
            seen.add(identity)
            pages.append(candidate)

        return pages

    def _navigate(self, page: Page, url: str) -> None:
        page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=self._navigation_timeout_ms,
        )

    @staticmethod
    def _roots(page: Page):
        roots = [page]
        try:
            for frame in page.frames:
                if frame is page.main_frame:
                    continue
                roots.append(frame)
        except Exception:
            pass
        return roots

    @staticmethod
    def _first_visible(root, selectors):
        for selector in selectors:
            locator = root.locator(selector)
            for index in range(min(locator.count(), 12)):
                candidate = locator.nth(index)
                try:
                    if candidate.is_visible():
                        return candidate
                except Exception:
                    continue
        return None

    @staticmethod
    def _first_visible_text_input(root):
        locator = root.locator(
            "input[type='text'], input:not([type]), input[type='email'], input[type='tel']"
        )
        for index in range(min(locator.count(), 12)):
            candidate = locator.nth(index)
            try:
                if candidate.is_visible():
                    return candidate
            except Exception:
                continue
        return None

    @staticmethod
    def _first_visible_role_button(root, pattern):
        locator = root.get_by_role("button", name=pattern)
        for index in range(min(locator.count(), 12)):
            candidate = locator.nth(index)
            try:
                if candidate.is_visible():
                    return candidate
            except Exception:
                continue
        return None

    @staticmethod
    def _sanitize_diagnostic(value):
        normalized = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
        return normalized[:160]

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