@echo off
setlocal EnableExtensions
set "URL=http://127.0.0.1:3010/supervisor"
call "%~dp092_ACESSOS.cmd" >nul 2>&1
if errorlevel 1 exit /b %ERRORLEVEL%
start "" "%URL%"
exit /b 0
