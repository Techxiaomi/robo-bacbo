@echo off
setlocal EnableExtensions
title MASTER SUPERVISOR - TRADER BINDINGS
set "ROOT=D:\Projetos\Bacbo"
set "AUTO_TRADER_ENABLED=true"
set "LIVE_BRIDGE_ARMED=YES"
set "MASTER_SUPERVISOR_TABLE_KEYS=bacbo_int,bacbo_br"
set "MASTER_SUPERVISOR_STAGGER_MS=5000"
set "MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=10000"
set "METRICS_FILE_NAME=backend.metrics.master-supervisor.json"
set "OPERATIONS_METRICS_NAMESPACE=master-supervisor"

echo ============================================================
echo  MASTER SUPERVISOR - ACTIVE TRADER BINDINGS
echo ============================================================
echo Workers sao derivados exclusivamente de Auto-Traders ATIVOS
echo e das contas explicitamente vinculadas a cada Trader.
echo Sem Trader ativo + vinculo valido = zero navegadores.
echo.

cd /d "%ROOT%\robo-bacbo"
node scripts\master_supervisor.js
