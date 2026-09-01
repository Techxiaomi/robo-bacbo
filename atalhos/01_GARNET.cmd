@echo off
setlocal EnableExtensions
set "ROOT=D:\Projetos\Bacbo"
title GARNET - Redis

if defined GARNET_EXE if exist "%GARNET_EXE%" goto :run

set "GARNET_EXE="
if exist "%ROOT%\garnet" (
  for /r "%ROOT%\garnet" %%F in (GarnetServer.exe) do (
    if not defined GARNET_EXE set "GARNET_EXE=%%~fF"
  )
)

if not defined GARNET_EXE (
  echo [ERRO] GarnetServer.exe nao encontrado em "%ROOT%\garnet".
  echo Defina GARNET_EXE com o caminho completo se o executavel estiver em outro local.
  pause
  exit /b 1
)

:run
echo [GARNET] %GARNET_EXE%
"%GARNET_EXE%"
