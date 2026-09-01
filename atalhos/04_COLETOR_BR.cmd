@echo off
setlocal EnableExtensions
title COLETOR - BACBO BR
set "ROOT=D:\Projetos\Bacbo"
set "PY=%ROOT%\python\venv\Scripts\python.exe"
set "BACBO_MESA_CODIGO=BACBO_BR"
set "BACBO_MESA_RUNTIME_ENABLED=1"
set "TIPMINER_BACBO_ROUND_ID=daed14c3-2a22-47b3-83c6-2c3a50c2ae69"
set "NODE_HOST=127.0.0.1"
set "NODE_PORT=3001"
cd /d "%ROOT%\robo-sync-pilot"
if not exist "%PY%" (
  echo [ERRO] Python do projeto nao encontrado: %PY%
  pause
  exit /b 1
)
"%PY%" tipminer_collector.py
