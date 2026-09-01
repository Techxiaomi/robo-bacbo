@echo off
setlocal EnableExtensions
title BACBO - Inicializador Operacional
set "BASE=%~dp0"

where wt.exe >nul 2>&1
if errorlevel 1 goto :sem_terminal

for %%F in (
  "01_GARNET.cmd"
  "02_COLETOR_INT.cmd"
  "03_NODE_INT.cmd"
  "04_COLETOR_BR.cmd"
  "05_NODE_BR.cmd"
) do (
  if not exist "%BASE%%%~F" goto :arquivo_ausente
)

echo [BACBO] Abrindo janela OPERACIONAL...
wt.exe -w new ^
  new-tab --title "Garnet" cmd.exe /k ""%BASE%01_GARNET.cmd"" ^; ^
  new-tab --title "Coletor INT" cmd.exe /k ""%BASE%02_COLETOR_INT.cmd"" ^; ^
  new-tab --title "Node INT" cmd.exe /k ""%BASE%03_NODE_INT.cmd"" ^; ^
  new-tab --title "Coletor BR" cmd.exe /k ""%BASE%04_COLETOR_BR.cmd"" ^; ^
  new-tab --title "Node BR" cmd.exe /k ""%BASE%05_NODE_BR.cmd""

if errorlevel 1 goto :falha_wt
exit /b 0

:sem_terminal
echo.
echo [ERRO] Windows Terminal ^(wt.exe^) nao encontrado no PATH.
echo Abra este arquivo por um Prompt/PowerShell para ver o diagnostico.
pause
exit /b 1

:arquivo_ausente
echo.
echo [ERRO] Um dos atalhos operacionais nao foi encontrado em:
echo %BASE%
pause
exit /b 1

:falha_wt
set "RC=%ERRORLEVEL%"
echo.
echo [ERRO] Windows Terminal recusou a abertura da janela OPERACIONAL.
echo Codigo de saida: %RC%
pause
exit /b %RC%
