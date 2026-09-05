@echo off
setlocal EnableExtensions
title BACKUP COMPLETO - ROBO BAC BO

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "BACKUP_SCRIPT=%ROOT%\01_BACKUP_COMPLETO.ps1"

if not exist "%BACKUP_SCRIPT%" (
    echo [ERRO] Script de backup nao encontrado:
    echo %BACKUP_SCRIPT%
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo  BACKUP COMPLETO - ROBO BAC BO
echo ============================================================
echo Projeto: %ROOT%
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BACKUP_SCRIPT%" -ProjectRoot "%ROOT%"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo [ERRO] Backup terminou com codigo %EXITCODE%.
) else (
    echo [OK] Backup completo finalizado com sucesso.
)
echo.
pause
exit /b %EXITCODE%
