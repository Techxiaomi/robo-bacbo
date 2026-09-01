@echo off
setlocal EnableExtensions
call "%~dp090_OPERACIONAL_ABAS.cmd"
timeout /t 2 /nobreak >nul
call "%~dp091_FINANCEIRO_ABAS.cmd"
timeout /t 2 /nobreak >nul
call "%~dp092_ACESSOS.cmd"
