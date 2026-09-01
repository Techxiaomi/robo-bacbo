@echo off
setlocal EnableExtensions
title BACBO - Inicializador Financeiro
set "BASE=%~dp0"

where wt.exe >nul 2>&1
if errorlevel 1 goto :sem_terminal

for %%F in (
  "06_MASTER_SUPERVISOR.cmd"
  "07_SIGNAL_ROUTER.cmd"
) do (
  if not exist "%BASE%%%~F" goto :arquivo_ausente
)

echo [BACBO] Abrindo janela FINANCEIRO / TRADER...
wt.exe -w new ^
  new-tab --title "Master Supervisor" cmd.exe /k ""%BASE%06_MASTER_SUPERVISOR.cmd"" ^; ^
  new-tab --title "Signal Router - DRY RUN" cmd.exe /k ""%BASE%07_SIGNAL_ROUTER.cmd""

if errorlevel 1 goto :falha_wt
exit /b 0

:sem_terminal
echo.
echo [ERRO] Windows Terminal ^(wt.exe^) nao encontrado no PATH.
pause
exit /b 1

:arquivo_ausente
echo.
echo [ERRO] Um dos atalhos financeiros nao foi encontrado em:
echo %BASE%
pause
exit /b 1

:falha_wt
set "RC=%ERRORLEVEL%"
echo.
echo [ERRO] Windows Terminal recusou a abertura da janela FINANCEIRO / TRADER.
echo Codigo de saida: %RC%
pause
exit /b %RC%
