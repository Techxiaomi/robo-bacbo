from adapters_py.base_adapter import BettingHouseAdapter
from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter


_ADAPTERS = {
    "brasil-da-sorte": BrasilDaSorteAdapter,
}
_FINANCIAL_METHODS = (
    "place_bet",
    "select_chip",
    "click_player",
    "click_banker",
    "click_tie",
)


def registered_adapter_keys():
    return tuple(sorted(_ADAPTERS))


def _required_house(config):
    house = config.get("house") if isinstance(config, dict) else None
    if not isinstance(house, dict):
        raise RuntimeError("ADAPTER_REGISTRY_HOUSE_CONFIG_REQUIRED")
    return house


def _required_session(config):
    session = config.get("session") if isinstance(config, dict) else None
    if not isinstance(session, dict):
        raise RuntimeError("ADAPTER_REGISTRY_SESSION_CONFIG_REQUIRED")
    return session


def _validated_account_id(config):
    house = _required_house(config)
    session = _required_session(config)

    try:
        house_id = int(house.get("id"))
        account_id = int(session.get("account_id"))
    except (TypeError, ValueError) as error:
        raise RuntimeError("ADAPTER_REGISTRY_ACCOUNT_ID_INVALID") from error

    if house_id <= 0 or account_id <= 0 or house_id != account_id:
        raise RuntimeError("ADAPTER_REGISTRY_ACCOUNT_ID_MISMATCH")
    return account_id


def _assert_navigation_only_contract(adapter_class):
    if not issubclass(adapter_class, BettingHouseAdapter):
        raise RuntimeError("ADAPTER_REGISTRY_CONTRACT_INVALID")

    for method_name in _FINANCIAL_METHODS:
        if getattr(adapter_class, method_name) is not getattr(BettingHouseAdapter, method_name):
            raise RuntimeError(
                f"ADAPTER_REGISTRY_FINANCIAL_OVERRIDE_FORBIDDEN: {method_name}"
            )


def create_adapter(browser, config):
    house = _required_house(config)
    _validated_account_id(config)

    adapter_key = str(house.get("adapter_key") or "").strip()
    adapter_class = _ADAPTERS.get(adapter_key)
    if adapter_class is None:
        raise RuntimeError(f"ADAPTER_REGISTRY_UNSUPPORTED: {adapter_key or '<empty>'}")

    _assert_navigation_only_contract(adapter_class)
    adapter = adapter_class(browser=browser, config=config)
    if not isinstance(adapter, BettingHouseAdapter):
        raise RuntimeError("ADAPTER_REGISTRY_INSTANCE_INVALID")
    return adapter
