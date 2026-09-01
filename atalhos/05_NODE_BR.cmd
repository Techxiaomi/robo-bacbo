@echo off
setlocal EnableExtensions
title NODE - BACBO BR
set "ROOT=D:\Projetos\Bacbo"
set "BACBO_MESA_CODIGO=BACBO_BR"
set "BACBO_MESA_RUNTIME_ENABLED=1"
set "TIPMINER_BACBO_ROUND_ID=daed14c3-2a22-47b3-83c6-2c3a50c2ae69"
set "NODE_HOST=127.0.0.1"
set "NODE_PORT=3001"
set "PORT=3001"
set "AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED=true"
set "SIGNAL_ROUTER_GLOBAL_CHANNEL=global_signals"
set "SIGNAL_ROUTER_RESULT_CHANNEL=global_signal_results"
cd /d "%ROOT%\robo-bacbo"
npm.cmd start
