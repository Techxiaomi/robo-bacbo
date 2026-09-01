import os

from playwright.sync_api import sync_playwright

from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter
from env_loader import load_env_file
from robo import localizar_frame_mesa, mesa_evolution_pronta, pagina_na_rota_da_mesa


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))


BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--window-size=1366,768",
]


def _env_required(name):
    value = str(os.getenv(name, "") or "").strip()
    if not value:
        raise RuntimeError(f"DRY_RUN_CONFIG_MISSING: {name}")
    return value


def _count_read_only(frame, selector):
    if frame is None:
        return 0
    try:
        return int(frame.locator(selector).count())
    except Exception:
        return 0


def main():
    game_url = _env_required("CASINO_GAME_URL")
    home_url = str(os.getenv("CASINO_HOME_URL", "") or "").strip()
    username = str(os.getenv("CASINO_USER", "") or "").strip()
    password = str(os.getenv("CASINO_PASSWORD", "") or "")
    session_state_file = str(os.getenv("SESSION_STATE_FILE", "") or "").strip()

    print("=== DRY RUN DISCOVERY | BRASIL DA SORTE ===")
    print("MODO=READ_ONLY | APOSTAS=DESABILITADAS_POR_DESIGN")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=BROWSER_ARGS)
        adapter = BrasilDaSorteAdapter(
            browser=browser,
            game_url=game_url,
            home_url=home_url,
            session_state_file=session_state_file,
            username=username,
            password=password,
        )

        try:
            adapter.prepare_session()
            adapter.launch_bacbo()
            page = adapter.get_game_page()

            url_ok = pagina_na_rota_da_mesa(page)
            evolution_ok = mesa_evolution_pronta(page)
            frame = localizar_frame_mesa(page)
            frame_ok = frame is not None

            chip_count = _count_read_only(frame, "[data-role='chip'][data-value]")
            bet_spot_count = _count_read_only(frame, "[data-role^='bacbo-bet-spot-']")

            print(f"DRY_RUN_URL_OK={url_ok}")
            print(f"DRY_RUN_EVOLUTION_FOUND={evolution_ok}")
            print(f"DRY_RUN_OPERATIONAL_FRAME={frame_ok}")
            print(f"DRY_RUN_CHIP_COUNT={chip_count}")
            print(f"DRY_RUN_BET_SPOT_COUNT={bet_spot_count}")

            if not (url_ok and evolution_ok and frame_ok):
                raise RuntimeError(
                    "DRY_RUN_DISCOVERY_FAILED: rota, Evolution ou frame operacional ausente."
                )

            print("DRY_RUN_DISCOVERY_SUCCESS: Evolution localizada sem executar apostas.")
        finally:
            adapter.cleanup()
            browser.close()


if __name__ == "__main__":
    main()
