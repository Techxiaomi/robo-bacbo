@echo off
setlocal EnableExtensions
title MASTER SUPERVISOR - INT + BR
set "ROOT=D:\Projetos\Bacbo"
set "AUTO_TRADER_ENABLED=true"
set "LIVE_BRIDGE_ARMED=YES"
set "LIVE_BRIDGE_MAX_EXPOSURE=5"
set "MASTER_SUPERVISOR_TABLE_KEYS=bacbo_int,bacbo_br"
set "MASTER_SUPERVISOR_STAGGER_MS=5000"
set "MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=10000"
cd /d "%ROOT%\robo-bacbo"
node scripts\master_supervisor.js
