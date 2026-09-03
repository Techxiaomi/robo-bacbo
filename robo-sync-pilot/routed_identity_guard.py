def _required_identity(config):
    if not isinstance(config, dict):
        raise RuntimeError("LIVE_BRIDGE_ROUTED_IDENTITY_CONFIG_REQUIRED")

    session = config.get("session")
    table = config.get("table")
    if not isinstance(session, dict) or not isinstance(table, dict):
        raise RuntimeError("LIVE_BRIDGE_ROUTED_IDENTITY_CONFIG_REQUIRED")

    try:
        account_id = int(session.get("account_id"))
    except (TypeError, ValueError) as error:
        raise RuntimeError("LIVE_BRIDGE_ROUTED_IDENTITY_ACCOUNT_INVALID") from error

    session_id = str(session.get("session_id") or "").strip()
    table_key = str(table.get("table_key") or "").strip().lower()
    if account_id <= 0 or not session_id or not table_key:
        raise RuntimeError("LIVE_BRIDGE_ROUTED_IDENTITY_CONFIG_INVALID")

    return account_id, session_id, table_key


def _command_identity(command):
    item = command if isinstance(command, dict) else {}
    try:
        account_id = int(item.get("routed_account_id"))
    except (TypeError, ValueError):
        account_id = None

    session_id = str(item.get("routed_session_id") or "").strip()
    table_key = str(item.get("routed_table_key") or "").strip().lower()
    return account_id, session_id, table_key


def _identity_missing(received):
    account_id, session_id, table_key = received
    return account_id is None and not session_id and not table_key


def _identity_mismatch_reason(expected, received):
    expected_account, expected_session, expected_table = expected
    received_account, received_session, received_table = received
    return (
        "LIVE_BRIDGE_ROUTED_IDENTITY_MISMATCH: "
        f"expected_account={expected_account} expected_session={expected_session} "
        f"expected_table={expected_table} received_account={received_account or '<missing>'} "
        f"received_session={received_session or '<missing>'} "
        f"received_table={received_table or '<missing>'}"
    )


def install_routed_identity_guard(robo_module, config):
    expected = _required_identity(config)
    installed = getattr(robo_module, "_live_bridge_routed_identity_guard", None)
    if installed is not None:
        if installed != expected:
            raise RuntimeError("LIVE_BRIDGE_ROUTED_IDENTITY_GUARD_RECONFIGURATION_FORBIDDEN")
        return False

    original_process = robo_module.processar_comando_playwright

    def guarded_process(playwright, session, command):
        item = command if isinstance(command, dict) else {}
        action = str(item.get("action") or "").strip()

        if action not in {"place_bet", "sync_balance"}:
            return original_process(playwright, session, command)

        received = _command_identity(item)
        if received == expected:
            return original_process(playwright, session, command)

        # Compatibilidade segura para o bootstrap de ativacao existente:
        # sync_balance e apenas leitura e ja chega por um command channel
        # exclusivo do worker account+table. Ausencia total de metadata roteada
        # pode seguir; metadata parcial ou divergente continua fail-closed.
        if action == "sync_balance" and _identity_missing(received):
            print(
                "LIVE_BRIDGE_ROUTED_IDENTITY_LEGACY_SYNC_BALANCE="
                f"accepted account={expected[0]} session={expected[1]} table={expected[2]}"
            )
            return original_process(playwright, session, command)

        reason = _identity_mismatch_reason(expected, received)

        if action == "place_bet":
            order_id = str(item.get("order_id") or "").strip().lower()
            if order_id:
                robo_module.finalizar_order_id(order_id, "FALHOU", motivo=reason)
        else:
            payload = {
                "action": "balance_error",
                "error": reason,
            }
            request_id = str(item.get("request_id") or "").strip()
            if request_id:
                payload["request_id"] = request_id
            try:
                robo_module.publicar_redis(payload)
            except Exception as publish_error:
                print(
                    "LIVE_BRIDGE_ROUTED_IDENTITY_ERROR_PUBLISH_FAILED="
                    f"{type(publish_error).__name__}: {str(publish_error)[:240]}"
                )

        print(
            "LIVE_BRIDGE_ROUTED_COMMAND_REJECTED="
            f"action={action} reason={reason}"
        )
        return None

    robo_module.processar_comando_playwright = guarded_process
    robo_module._live_bridge_routed_identity_guard = expected
    print(
        "LIVE_BRIDGE_ROUTED_IDENTITY_GUARD=installed "
        f"account={expected[0]} session={expected[1]} table={expected[2]}"
    )
    return True


__all__ = ["install_routed_identity_guard"]
