@echo off
setlocal EnableExtensions
title NODE - BACBO INT
set "ROOT=D:\Projetos\Bacbo"
set "BACBO_MESA_CODIGO=BACBO_INT"
set "NODE_HOST=127.0.0.1"
set "NODE_PORT=3000"
set "PORT=3000"
set "OPERATIONS_METRICS_FILE_NAME=backend.operations.BACBO_INT.json"
set "AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED=true"
set "SIGNAL_ROUTER_GLOBAL_CHANNEL=global_signals"
set "SIGNAL_ROUTER_RESULT_CHANNEL=global_signal_results"
cd /d "%ROOT%\robo-bacbo"
npm.cmd start
