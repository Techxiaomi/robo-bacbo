@echo off
setlocal EnableExtensions
set "BASE=%~dp0"
where wt.exe >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Windows Terminal (wt.exe) nao encontrado.
  pause
  exit /b 1
)

start "" wt.exe -w new new-tab --title "Garnet" cmd.exe /k call "%BASE%01_GARNET.cmd" ^; new-tab --title "Coletor INT" cmd.exe /k call "%BASE%02_COLETOR_INT.cmd" ^; new-tab --title "Node INT" cmd.exe /k call "%BASE%03_NODE_INT.cmd" ^; new-tab --title "Coletor BR" cmd.exe /k call "%BASE%04_COLETOR_BR.cmd" ^; new-tab --title "Node BR" cmd.exe /k call "%BASE%05_NODE_BR.cmd"
