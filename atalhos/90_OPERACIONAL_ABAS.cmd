@echo off
setlocal EnableExtensions
title BACBO - Inicializador Operacional
set "ROOT=D:\Projetos\Bacbo"
set "LAUNCHER=%~dp0Start-Operacional.ps1"

if not exist "%LAUNCHER%" (
  echo [ERRO] Launcher operacional nao encontrado: %LAUNCHER%
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Root "%ROOT%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERRO] Inicializacao operacional falhou com codigo %RC%.
  pause
  exit /b %RC%
)
exit /b 0
