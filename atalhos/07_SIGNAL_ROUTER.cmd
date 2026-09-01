@echo off
setlocal EnableExtensions
title SIGNAL ROUTER - DRY RUN
set "ROOT=D:\Projetos\Bacbo"
set "SIGNAL_ROUTER_GLOBAL_CHANNEL=global_signals"
set "SIGNAL_ROUTER_RESULT_CHANNEL=global_signal_results"
set "SIGNAL_ROUTER_RESPONSE_PATTERN=auto_trader_responses:*:*"
set "SIGNAL_ROUTER_FINANCIAL_FANOUT_ENABLED=true"
set "SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true"
set "SIGNAL_ROUTER_FINANCIAL_FANIN_SIMULATION=false"
set "SIGNAL_ROUTER_GLOBAL_MAX_EXPOSURE=20.00"
set "SIGNAL_ROUTER_RESULT_TIMEOUT_MS=210000"
cd /d "%ROOT%\robo-bacbo"
node scripts\signal_router.js
