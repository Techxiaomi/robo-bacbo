from abc import ABC, abstractmethod

from playwright.sync_api import Browser, BrowserContext, Page


class BettingHouseAdapter(ABC):
    """Contrato de navegação da casa; nunca contém lógica financeira."""

    def __init__(self, browser: Browser):
        if browser is None or not hasattr(browser, "new_context"):
            raise TypeError("ADAPTER_INVALID_BROWSER: esperado Playwright Browser sync.")

        self._browser = browser
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    @property
    def context(self) -> BrowserContext | None:
        return self._context

    @property
    def page(self) -> Page | None:
        return self._page

    @abstractmethod
    def prepare_session(self) -> Page:
        """Cria o BrowserContext isolado e devolve a Page pertencente ao adapter."""
        raise NotImplementedError

    @abstractmethod
    def pre_launch(self) -> Page:
        """Executa autenticação/navegação da casa até a mesa configurada."""
        raise NotImplementedError

    @abstractmethod
    def get_game_page(self) -> Page:
        """Devolve exclusivamente a Page pronta para handoff ao motor universal."""
        raise NotImplementedError

    def cleanup(self) -> None:
        context = self._context
        self._page = None
        self._context = None
        if context is not None:
            context.close()

    def _require_prepared_page(self) -> Page:
        page = self._page
        if page is None or page.is_closed():
            raise RuntimeError(
                "ADAPTER_PAGE_NOT_READY: execute prepare_session() antes do handoff."
            )
        return page

    def place_bet(self, *args, **kwargs):
        raise RuntimeError("ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: place_bet pertence ao motor.")

    def select_chip(self, *args, **kwargs):
        raise RuntimeError("ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: select_chip pertence ao motor.")

    def click_player(self, *args, **kwargs):
        raise RuntimeError("ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: click_player pertence ao motor.")

    def click_banker(self, *args, **kwargs):
        raise RuntimeError("ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: click_banker pertence ao motor.")

    def click_tie(self, *args, **kwargs):
        raise RuntimeError("ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: click_tie pertence ao motor.")
