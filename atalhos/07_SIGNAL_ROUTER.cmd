@echo off
setlocal EnableExtensions
title SIGNAL ROUTER - DRY RUN
set "ROOT=D:\Projetos\Bacbo"
set "SIGNAL_ROUTER_GLOBAL_CHANNEL=global_signals"
set "SIGNAL_ROUTER_RESULT_CHANNEL=global_signal_results"
set "SIGNAL_ROUTER_RESPONSE_PATTERN=auto_trader_responses:*:*"
set "SIGNAL_ROUTER_FINANCIAL_FANOUT_ENABLED=true"
set "SIGNAL_ROUTER_FINANCIAL_FANIN_SIMULATION=false"
set "SIGNAL_ROUTER_RESULT_TIMEOUT_MS=210000"
set "METRICS_FILE_NAME=backend.metrics.signal-router.json"
set "OPERATIONS_METRICS_NAMESPACE=signal-router"
cd /d "%ROOT%\robo-bacbo"
node scripts\run_with_system_config.js scripts\signal_router.js
