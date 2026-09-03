@echo off
setlocal EnableExtensions
title BACBO - Acessos Universais

cd /d "%~dp0..\robo-bacbo"
if errorlevel 1 goto :erro

set "OPERATIONS_METRICS_NAMESPACE=accesses-server"
set "BETTING_HOUSE_API_DEV_PORT=3010"

echo ================================================
echo  BACBO - ACESSOS UNIVERSAIS
echo ================================================
echo Casas, contas e processos de Traders.
echo URL: http://127.0.0.1:3010/accesses
echo.

node ".\scripts\betting_house_api_dev_server.js"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :erro_codigo
exit /b 0

:erro
echo [ERRO] Nao foi possivel acessar robo-bacbo.
pause
exit /b 1

:erro_codigo
echo [ERRO] Servidor de Acessos terminou com codigo %RC%.
pause
exit /b %RC%
