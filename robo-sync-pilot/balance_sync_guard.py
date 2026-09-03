import time


_MAX_ATTEMPTS = 3
_RETRY_DELAY_SECONDS = 0.35
_installed = False


def install_balance_sync_guard(robo_module):
    global _installed
    if _installed:
        return False

    original_process = robo_module.processar_comando_playwright
    original_publish_balance = robo_module.publicar_saldo_redis

    def guarded_process(playwright, session, command):
        action = str((command or {}).get("action") or "").strip()
        if action != "sync_balance":
            return original_process(playwright, session, command)

        request_id = str((command or {}).get("request_id") or "").strip()
        last_error = None

        def publish_correlated_balance(balance):
            payload = {
                "action": "balance_update",
                "balance": round(float(balance), 2),
            }
            if request_id:
                payload["request_id"] = request_id
            return robo_module.publicar_redis(payload)

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            robo_module.publicar_saldo_redis = publish_correlated_balance
            try:
                print(
                    f"LIVE_BRIDGE_BALANCE_SYNC_ATTEMPT={attempt}/{_MAX_ATTEMPTS} "
                    f"request_id={request_id or 'none'}"
                )
                original_process(playwright, session, command)
                print(
                    f"LIVE_BRIDGE_BALANCE_SYNC_OK attempt={attempt} "
                    f"request_id={request_id or 'none'}"
                )
                return
            except Exception as error:
                last_error = error
                print(
                    "LIVE_BRIDGE_BALANCE_SYNC_RETRY="
                    f"attempt={attempt} error={type(error).__name__}: {str(error)[:240]}"
                )
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(_RETRY_DELAY_SECONDS)
            finally:
                robo_module.publicar_saldo_redis = original_publish_balance

        payload = {
            "action": "balance_error",
            "error": f"{type(last_error).__name__}: {str(last_error)[:240]}",
        }
        if request_id:
            payload["request_id"] = request_id
        try:
            robo_module.publicar_redis(payload)
        except Exception as publish_error:
            print(
                "LIVE_BRIDGE_BALANCE_ERROR_PUBLISH_FAILED="
                f"{type(publish_error).__name__}: {str(publish_error)[:240]}"
            )

        print(
            "LIVE_BRIDGE_BALANCE_SYNC_FAILED_NONFATAL="
            f"request_id={request_id or 'none'} error={payload['error']}"
        )
        return

    robo_module.processar_comando_playwright = guarded_process
    _installed = True
    print("LIVE_BRIDGE_BALANCE_SYNC_GUARD=installed")
    return True


__all__ = ["install_balance_sync_guard"]
