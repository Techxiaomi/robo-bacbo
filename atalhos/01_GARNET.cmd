@echo off
setlocal EnableExtensions
title GARNET - Redis
set "ROOT=D:\Projetos\Bacbo"
set "LAUNCHER=%~dp0Garnet-Launcher.ps1"

if not exist "%LAUNCHER%" (
  echo [ERRO] Launcher Garnet nao encontrado: %LAUNCHER%
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Root "%ROOT%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERRO] Garnet encerrou com codigo %RC%.
  pause
  exit /b %RC%
)
