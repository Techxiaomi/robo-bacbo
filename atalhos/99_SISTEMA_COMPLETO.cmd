@echo off
setlocal EnableExtensions
title BACBO - Inicializacao Completa
set "BASE=%~dp0"

echo ================================================
echo  BACBO - INICIALIZACAO COMPLETA
echo ================================================
echo.

if not exist "%BASE%90_OPERACIONAL_ABAS.cmd" goto :arquivo_ausente
if not exist "%BASE%91_FINANCEIRO_ABAS.cmd" goto :arquivo_ausente

echo [1/2] Abrindo stack OPERACIONAL em ordem segura...
call "%BASE%90_OPERACIONAL_ABAS.cmd"
if errorlevel 1 goto :falha_operacional

timeout /t 2 /nobreak >nul

echo [2/2] Adicionando Supervisor, Router e Acessos na MESMA janela...
call "%BASE%91_FINANCEIRO_ABAS.cmd"
if errorlevel 1 goto :falha_financeiro

echo.
echo [OK] Sistema organizado em uma unica janela com 8 abas:
echo      Garnet ^| Node INT ^| Node BR ^| Coletor INT ^| Coletor BR ^| Master Supervisor ^| Signal Router ^| Acessos
echo.
echo      Portal universal: http://127.0.0.1:3010/accesses
echo      Use 92_ACESSOS.cmd para abrir quando quiser.
echo.
pause
exit /b 0

:arquivo_ausente
echo.
echo [ERRO] Estrutura de atalhos incompleta em:
echo %BASE%
pause
exit /b 1

:falha_operacional
echo.
echo [ERRO] A stack OPERACIONAL nao foi iniciada completamente.
echo Corrija o erro exibido acima antes de prosseguir.
pause
exit /b 1

:falha_financeiro
echo.
echo [ERRO] Supervisor/Router/Acessos nao foram adicionados a janela principal.
echo A stack operacional pode ter sido aberta normalmente.
pause
exit /b 1
