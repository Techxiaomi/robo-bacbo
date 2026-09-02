@echo off
setlocal EnableExtensions
title BACBO - Encerramento Total
set "BASE=%~dp0"
set "STOPPER=%BASE%Stop-Sistema.ps1"

if not exist "%STOPPER%" (
  echo [ERRO] Stop-Sistema.ps1 nao encontrado:
  echo %STOPPER%
  pause
  exit /b 1
)

echo ================================================
echo  BACBO - ENCERRAMENTO TOTAL PARA MANUTENCAO
echo ================================================
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%STOPPER%" -Root "D:\Projetos\Bacbo"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [ERRO] Encerramento terminou com codigo %RC%.
  pause
  exit /b %RC%
)

echo [OK] Todos os modulos BACBO foram encerrados.
pause
exit /b 0
