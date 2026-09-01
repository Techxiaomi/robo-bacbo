import json
import sys

from playwright.sync_api import sync_playwright

from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter
import robo


MAX_CONFIG_BYTES = 64 * 1024
BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--window-size=1366,768",
]


def _read_config_from_stdin():
    raw = sys.stdin.buffer.read(MAX_CONFIG_BYTES + 1)
    if len(raw) > MAX_CONFIG_BYTES:
        raise RuntimeError("DRY_RUN_CONFIG_TOO_LARGE")
    if not raw.strip():
        raise RuntimeError("DRY_RUN_CONFIG_MISSING")

    try:
        config = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("DRY_RUN_CONFIG_INVALID_JSON") from error

    if not isinstance(config, dict):
        raise RuntimeError("DRY_RUN_CONFIG_INVALID")
    return config


def _required_nested(config, section, key):
    group = config.get(section)
    if not isinstance(group, dict):
        raise RuntimeError(f"DRY_RUN_CONFIG_MISSING: {section}.{key}")
    value = str(group.get(key) or "").strip()
    if not value:
        raise RuntimeError(f"DRY_RUN_CONFIG_MISSING: {section}.{key}")
    return value


def main():
    config = _read_config_from_stdin()
    adapter_key = _required_nested(config, "house", "adapter_key")
    table_key = _required_nested(config, "table", "table_key")
    game_url = _required_nested(config, "table", "game_url")
    home_url = _required_nested(config, "house", "home_url")

    if adapter_key != "brasil-da-sorte":
        raise RuntimeError("DRY_RUN_ADAPTER_UNSUPPORTED")
    if table_key != "bacbo_br":
        raise RuntimeError("DRY_RUN_TABLE_UNSUPPORTED")

    robo.URL_CASSINO = game_url
    robo.URL_HOME_CASSINO = home_url

    print("DRY_RUN_BROWSER_MODE=HEADED")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False, args=BROWSER_ARGS)
        adapter = BrasilDaSorteAdapter(browser=browser, config=config)

        try:
            adapter.prepare_session()
            adapter.pre_launch()
            page = adapter.get_game_page()

            url_ok = robo.pagina_na_rota_da_mesa(page)
            evolution_found = robo.aguardar_mesa_evolution(page, 30000)
            operational_frame = robo.localizar_frame_mesa(page) is not None

            print(f"DRY_RUN_URL_OK={url_ok}")
            print(f"DRY_RUN_EVOLUTION_FOUND={evolution_found}")
            print(f"DRY_RUN_OPERATIONAL_FRAME={operational_frame}")

            if not (url_ok and evolution_found and operational_frame):
                raise RuntimeError("DRY_RUN_DISCOVERY_FAILED")
        finally:
            adapter.cleanup()
            browser.close()


if __name__ == "__main__":
    main()
