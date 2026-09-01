import os

from playwright.sync_api import sync_playwright

from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter
from env_loader import load_env_file
import robo


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


def _env_optional(name):
    return str(os.getenv(name, "") or "").strip()


def _count_read_only(frame, selector):
    if frame is None:
        return 0
    try:
        return int(frame.locator(selector).count())
    except Exception:
        return 0


def main():
    game_url = _env_required("BRASIL_DA_SORTE_GAME_URL")
    home_url = _env_optional("BRASIL_DA_SORTE_HOME_URL")
    username = _env_optional("BRASIL_DA_SORTE_USER")
    password = _env_optional("BRASIL_DA_SORTE_PASSWORD")
    session_state_file = _env_optional("BRASIL_DA_SORTE_SESSION_STATE_FILE")
    username_selector = _env_optional("BRASIL_DA_SORTE_LOGIN_USERNAME_SELECTOR")
    password_selector = _env_optional("BRASIL_DA_SORTE_LOGIN_PASSWORD_SELECTOR")
    submit_selector = _env_optional("BRASIL_DA_SORTE_LOGIN_SUBMIT_SELECTOR")

    # Somente neste processo de diagnostico: as funcoes read-only do motor
    # devem comparar contra a rota da casa que esta sendo inspecionada.
    robo.URL_CASSINO = game_url
    robo.URL_HOME_CASSINO = home_url

    print("=== DRY RUN DISCOVERY | BRASIL DA SORTE ===")
    print("MODO=READ_ONLY | APOSTAS=DESABILITADAS_POR_DESIGN")
    print("CONFIG_SOURCE=BRASIL_DA_SORTE_*")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=BROWSER_ARGS)
        adapter = BrasilDaSorteAdapter(
            browser=browser,
            game_url=game_url,
            home_url=home_url,
            session_state_file=session_state_file,
            username=username,
            password=password,
            username_selector=username_selector,
            password_selector=password_selector,
            submit_selector=submit_selector,
        )

        try:
            adapter.prepare_session()
            adapter.launch_bacbo()
            page = adapter.get_game_page()

            url_ok = robo.pagina_na_rota_da_mesa(page)
            evolution_ok = robo.mesa_evolution_pronta(page)
            frame = robo.localizar_frame_mesa(page)
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
