@echo off
setlocal EnableExtensions
title MASTER SUPERVISOR - IDLE / FAIL-CLOSED
set "ROOT=D:\Projetos\Bacbo"
set "AUTO_TRADER_ENABLED=true"
set "LIVE_BRIDGE_ARMED=YES"
set "LIVE_BRIDGE_MAX_EXPOSURE=5"

rem Fail-closed: ate existir vinculo persistido Auto-Trader -> Conta(s),
rem o Supervisor nao pode inferir contas a partir de todas as casas habilitadas.
rem Filtro impossivel = Supervisor ativo/telemetria ativa, zero workers Playwright.
set "MASTER_SUPERVISOR_TABLE_KEYS=__auto_trader_account_binding_required__"
set "MASTER_SUPERVISOR_STAGGER_MS=5000"
set "MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=10000"

echo ============================================================
echo  MASTER SUPERVISOR - IDLE / FAIL-CLOSED
echo ============================================================
echo Nenhum navegador financeiro sera aberto no bootstrap.
echo Workers serao liberados somente apos vinculo explicito Trader -^> Conta(s).
echo.

cd /d "%ROOT%\robo-bacbo"
node scripts\master_supervisor.js
