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
if not exist "%BASE%92_ACESSOS.cmd" goto :arquivo_ausente

echo [1/3] Abrindo stack OPERACIONAL...
call "%BASE%90_OPERACIONAL_ABAS.cmd"
if errorlevel 1 goto :falha_operacional

timeout /t 2 /nobreak >nul

echo [2/3] Abrindo stack FINANCEIRO / TRADER...
call "%BASE%91_FINANCEIRO_ABAS.cmd"
if errorlevel 1 goto :falha_financeiro

timeout /t 2 /nobreak >nul

echo [3/3] Abrindo acessos de Supervisor e Casas / Contas...
call "%BASE%92_ACESSOS.cmd"
if errorlevel 1 (
  echo [AVISO] Os modulos foram iniciados, mas um acesso do navegador falhou.
)

echo.
echo [OK] Solicitacao de inicializacao completa concluida.
echo      Janela OPERACIONAL: Garnet, Coletores e Nodes.
echo      Janela FINANCEIRO: Supervisor e Signal Router.
echo.
echo Esta janela pode ser fechada agora.
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
echo [ERRO] A janela OPERACIONAL nao foi iniciada.
echo Corrija o erro exibido acima antes de prosseguir.
pause
exit /b 1

:falha_financeiro
echo.
echo [ERRO] A janela FINANCEIRO / TRADER nao foi iniciada.
echo A janela OPERACIONAL pode ter sido aberta normalmente.
pause
exit /b 1
