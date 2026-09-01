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

echo [2/2] Abrindo stack FINANCEIRO / TRADER...
call "%BASE%91_FINANCEIRO_ABAS.cmd"
if errorlevel 1 goto :falha_financeiro

echo.
echo [OK] Solicitacao de inicializacao completa concluida.
echo      Acessos web NAO sao abertos automaticamente.
echo      Use 08_ABRIR_SUPERVISOR.cmd ou 09_ABRIR_CASAS_CONTAS.cmd quando quiser.
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
echo [ERRO] A janela OPERACIONAL nao foi iniciada completamente.
echo Corrija o erro exibido acima antes de prosseguir.
pause
exit /b 1

:falha_financeiro
echo.
echo [ERRO] A janela FINANCEIRO / TRADER nao foi iniciada.
echo A janela OPERACIONAL pode ter sido aberta normalmente.
pause
exit /b 1
