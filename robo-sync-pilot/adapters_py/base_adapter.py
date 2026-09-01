from abc import ABC, abstractmethod


class BettingHouseAdapter(ABC):
    """Contrato da casca: sessao e pre-launch, nunca logica financeira."""

    def __init__(self, browser):
        if browser is None or not hasattr(browser, "new_context"):
            raise TypeError("ADAPTER_INVALID_BROWSER: esperado Playwright Browser sync.")

        self._browser = browser
        self._context = None
        self._page = None

    @property
    def context(self):
        return self._context

    @property
    def page(self):
        return self._page

    @abstractmethod
    def prepare_session(self):
        raise NotImplementedError

    @abstractmethod
    def launch_bacbo(self):
        raise NotImplementedError

    @abstractmethod
    def get_game_page(self):
        raise NotImplementedError

    def cleanup(self):
        """Fecha apenas o BrowserContext pertencente a esta conta."""
        context = self._context
        self._page = None
        self._context = None

        if context is not None:
            context.close()

    def _require_prepared_page(self):
        page = self._page
        if page is None or page.is_closed():
            raise RuntimeError(
                "ADAPTER_PAGE_NOT_READY: execute prepare_session() antes do handoff."
            )
        return page

    # Barreiras arquiteturais explicitas: cliques financeiros nao pertencem ao adapter.
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
