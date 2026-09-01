import json
import queue
import sys
import threading
import time

from playwright.sync_api import sync_playwright

from adapters_py.brasil_da_sorte import BrasilDaSorteAdapter
import robo


MAX_CONFIG_BYTES = 64 * 1024
SUPPORTED_TABLE_KEYS = {"bacbo_br", "bacbo_int"}
CONTROLLED_MAX_EXPOSURE_CAP = 5.0
KEEP_ALIVE_INTERVAL_SECONDS = 15.0
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
        raise RuntimeError("LIVE_BRIDGE_CONFIG_TOO_LARGE")
    if not raw.strip():
        raise RuntimeError("LIVE_BRIDGE_CONFIG_MISSING")

    try:
        config = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("LIVE_BRIDGE_CONFIG_INVALID_JSON") from error

    if not isinstance(config, dict):
        raise RuntimeError("LIVE_BRIDGE_CONFIG_INVALID")
    return config


def _required_nested(config, section, key):
    group = config.get(section)
    if not isinstance(group, dict):
        raise RuntimeError(f"LIVE_BRIDGE_CONFIG_MISSING: {section}.{key}")
    value = str(group.get(key) or "").strip()
    if not value:
        raise RuntimeError(f"LIVE_BRIDGE_CONFIG_MISSING: {section}.{key}")
    return value


def _validate_config(config):
    adapter_key = _required_nested(config, "house", "adapter_key")
    table_key = _required_nested(config, "table", "table_key")
    game_url = _required_nested(config, "table", "game_url")
    home_url = _required_nested(config, "house", "home_url")

    if adapter_key != "brasil-da-sorte":
        raise RuntimeError("LIVE_BRIDGE_ADAPTER_UNSUPPORTED")
    if table_key not in SUPPORTED_TABLE_KEYS:
        raise RuntimeError("LIVE_BRIDGE_TABLE_UNSUPPORTED")

    safety = config.get("safety")
    if not isinstance(safety, dict) or safety.get("armed") is not True:
        raise RuntimeError("LIVE_BRIDGE_NOT_ARMED")
    if str(safety.get("mode") or "").strip() != "controlled":
        raise RuntimeError("LIVE_BRIDGE_MODE_INVALID")

    try:
        max_exposure = float(safety.get("max_exposure"))
    except (TypeError, ValueError) as error:
        raise RuntimeError("LIVE_BRIDGE_MAX_EXPOSURE_INVALID") from error

    if max_exposure <= 0 or max_exposure > CONTROLLED_MAX_EXPOSURE_CAP:
        raise RuntimeError(
            f"LIVE_BRIDGE_MAX_EXPOSURE_OUT_OF_RANGE: max={CONTROLLED_MAX_EXPOSURE_CAP:.2f}"
        )

    if not robo.auto_trader_habilitado():
        raise RuntimeError("LIVE_BRIDGE_AUTO_TRADER_DISABLED")

    robo.URL_CASSINO = game_url
    robo.URL_HOME_CASSINO = home_url
    return table_key, max_exposure


def _adapter_session_healthy(page):
    if page is None:
        return False
    try:
        if page.is_closed():
            return False
        return (
            robo.pagina_na_rota_da_mesa(page)
            and robo.mesa_evolution_pronta(page)
            and not robo.pagina_indica_conexao_caida(page)
        )
    except Exception:
        return False


def _require_adapter_session_healthy(page):
    if not _adapter_session_healthy(page):
        raise RuntimeError("LIVE_BRIDGE_ADAPTER_SESSION_UNHEALTHY")


def _disable_legacy_login(page, context):
    print("LIVE_BRIDGE_LEGACY_LOGIN_BLOCKED=true")
    return False


def _exposure_for_command(command):
    legs = robo.normalizar_apostas_recebidas(command)
    return float(sum(float(item["valor"]) for item in legs))


def _reject_place_bet(command, reason):
    order_id = str(command.get("order_id") or "").strip().lower()
    if order_id:
        robo.finalizar_order_id(order_id, "FALHOU", motivo=reason)
    print(f"LIVE_BRIDGE_ORDER_REJECTED={reason}")


def _process_controlled_command(playwright, session, command, max_exposure):
    action = str(command.get("action") or "").strip()
    page = session.get("page")
    _require_adapter_session_healthy(page)

    if action == "place_bet":
        try:
            exposure = _exposure_for_command(command)
        except Exception as error:
            _reject_place_bet(command, f"LIVE_BRIDGE_ORDER_INVALID: {error}")
            return

        print(f"LIVE_BRIDGE_ORDER_EXPOSURE={exposure:.2f}")
        if exposure > max_exposure + 1e-9:
            _reject_place_bet(
                command,
                f"LIVE_BRIDGE_MAX_EXPOSURE_EXCEEDED: exposure={exposure:.2f}, max={max_exposure:.2f}",
            )
            return

        robo.processar_comando_playwright(playwright, session, command)
        return

    if action == "sync_balance":
        robo.processar_comando_playwright(playwright, session, command)
        return

    print(f"LIVE_BRIDGE_COMMAND_REJECTED={action or 'EMPTY'}")


def _controlled_cycle(playwright, session, max_exposure):
    last_keep_alive = 0.0

    while not robo.encerrar_executor.is_set():
        now = time.monotonic()
        if now - last_keep_alive >= KEEP_ALIVE_INTERVAL_SECONDS:
            page = session.get("page")
            robo.fechar_popup_inatividade(page)
            _require_adapter_session_healthy(page)
            last_keep_alive = now

        try:
            command = robo.fila_comandos_redis.get(timeout=1.0)
        except queue.Empty:
            continue

        if robo.encerrar_executor.is_set():
            return

        _process_controlled_command(playwright, session, command, max_exposure)
        session["ultima_manutencao"] = time.monotonic()
        robo.registrar_atividade_node()


def _worker(config, max_exposure, ready_event, worker_error):
    session = {
        "browser": None,
        "context": None,
        "page": None,
        "ultima_manutencao": 0.0,
    }

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False, args=BROWSER_ARGS)
            adapter = BrasilDaSorteAdapter(browser=browser, config=config)
            session["browser"] = browser

            try:
                page = adapter.prepare_session()
                adapter.pre_launch()
                context = adapter._context

                session.update({
                    "context": context,
                    "page": page,
                    "ultima_manutencao": time.monotonic(),
                })
                robo.navegador_aberto.set()
                _require_adapter_session_healthy(page)
                print("LIVE_BRIDGE_ADAPTER_PAGE_READY=true")
                ready_event.set()

                _controlled_cycle(playwright, session, max_exposure)
            finally:
                robo.navegador_aberto.clear()
                adapter.cleanup()
                try:
                    browser.close()
                except Exception:
                    pass
    except Exception as error:
        worker_error.append(error)
        ready_event.set()
        robo.solicitar_encerramento_executor()


def main():
    config = _read_config_from_stdin()
    table_key, max_exposure = _validate_config(config)

    # Live Bridge nunca usa o login legado do executor universal. A sessão é
    # propriedade do Adapter; perda de sessão encerra o bridge fail-closed.
    robo.renovar_sessao_automaticamente = _disable_legacy_login
    robo.encerrar_executor.clear()

    print("=== LIVE BRIDGE CONTROLLED ===")
    print(f"LIVE_BRIDGE_TABLE={table_key}")
    print("LIVE_BRIDGE_MODE=controlled")
    print(f"LIVE_BRIDGE_MAX_EXPOSURE={max_exposure:.2f}")
    print("LIVE_BRIDGE_FINANCIAL_ENGINE=robo.executar_place_bet")
    print("LIVE_BRIDGE_LEGACY_LOGIN_ENABLED=false")

    ready_event = threading.Event()
    worker_error = []

    worker_thread = threading.Thread(
        target=_worker,
        args=(config, max_exposure, ready_event, worker_error),
        name="bacbo-live-adapter-worker",
        daemon=True,
    )
    redis_thread = threading.Thread(
        target=robo.ouvir_comandos_redis,
        name="bacbo-live-redis-listener",
        daemon=True,
    )

    worker_thread.start()
    if not ready_event.wait(timeout=90.0):
        robo.solicitar_encerramento_executor()
        raise RuntimeError("LIVE_BRIDGE_ADAPTER_START_TIMEOUT")
    if worker_error:
        raise RuntimeError(f"LIVE_BRIDGE_WORKER_START_FAILED: {worker_error[0]}")

    redis_thread.start()
    print("LIVE_BRIDGE_READY=true")

    try:
        while not robo.encerrar_executor.wait(0.5):
            if not worker_thread.is_alive():
                raise RuntimeError("LIVE_BRIDGE_WORKER_STOPPED")
            if not redis_thread.is_alive():
                raise RuntimeError("LIVE_BRIDGE_REDIS_LISTENER_STOPPED")
    except KeyboardInterrupt:
        print("\nLIVE_BRIDGE_SHUTDOWN_REQUESTED=true")
    finally:
        robo.solicitar_encerramento_executor()

        while robo.auto_trader_operando.is_set():
            try:
                time.sleep(0.10)
            except KeyboardInterrupt:
                pass

        redis_thread.join(timeout=3.0)
        worker_thread.join(timeout=10.0)
        print("LIVE_BRIDGE_STOPPED=true")


if __name__ == "__main__":
    main()
