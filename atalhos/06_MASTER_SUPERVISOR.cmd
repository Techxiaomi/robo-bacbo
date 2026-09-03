@echo off
setlocal EnableExtensions
title MASTER SUPERVISOR - TRADER BINDINGS
set "ROOT=D:\Projetos\Bacbo"
set "AUTO_TRADER_ENABLED=true"
set "LIVE_BRIDGE_ARMED=YES"
set "MASTER_SUPERVISOR_TABLE_KEYS=bacbo_int,bacbo_br"
set "MASTER_SUPERVISOR_STAGGER_MS=2000"
set "MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=2000"
set "METRICS_FILE_NAME=backend.metrics.master-supervisor.json"
set "OPERATIONS_METRICS_NAMESPACE=master-supervisor"

echo ============================================================
echo  MASTER SUPERVISOR - FAST EVENT-DRIVEN BINDINGS
echo ============================================================
echo Wake imediato na ativacao + polling de 2s como fallback.
echo Stagger de 2s reduz pico simultaneo de Chromium em hardware modesto.
echo Sem Trader ativo + vinculo valido = zero navegadores.
echo.

cd /d "%ROOT%\robo-bacbo"
node scripts\run_with_system_config.js scripts\master_supervisor_fast.js
