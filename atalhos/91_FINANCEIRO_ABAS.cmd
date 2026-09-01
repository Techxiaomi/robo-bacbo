@echo off
setlocal EnableExtensions
set "BASE=%~dp0"
where wt.exe >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Windows Terminal (wt.exe) nao encontrado.
  pause
  exit /b 1
)

start "" wt.exe -w new new-tab --title "Master Supervisor" cmd.exe /k call "%BASE%06_MASTER_SUPERVISOR.cmd" ^; new-tab --title "Signal Router - DRY RUN" cmd.exe /k call "%BASE%07_SIGNAL_ROUTER.cmd"
