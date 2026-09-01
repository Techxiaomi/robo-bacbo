@echo off
setlocal EnableExtensions
title COLETOR - BACBO INT
set "ROOT=D:\Projetos\Bacbo"
set "PY=%ROOT%\python\venv\Scripts\python.exe"
set "BACBO_MESA_CODIGO=BACBO_INT"
set "TIPMINER_BACBO_ROUND_ID=cc71e81d-8b56-4868-91c7-7224be543dce"
set "NODE_HOST=127.0.0.1"
set "NODE_PORT=3000"
cd /d "%ROOT%\robo-sync-pilot"
if not exist "%PY%" (
  echo [ERRO] Python do projeto nao encontrado: %PY%
  pause
  exit /b 1
)
"%PY%" tipminer_collector.py
