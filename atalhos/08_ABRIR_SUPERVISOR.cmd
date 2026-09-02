@echo off
setlocal EnableExtensions
title BACBO - Abrir Supervisores

set "HOST=127.0.0.1"
set "INT_PORT=3000"
set "BR_PORT=3001"
set "WAIT_SECONDS=30"

echo ================================================
echo  BACBO - ACESSO AOS SUPERVISORES
echo ================================================
echo.
echo Aguardando Node INT :%INT_PORT% e Node BR :%BR_PORT%...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(%WAIT_SECONDS%);" ^
  "$ports=@(%INT_PORT%,%BR_PORT%);" ^
  "do {" ^
  "  $ready=$true;" ^
  "  foreach($port in $ports){" ^
  "    $ok=$false;" ^
  "    try { $client=New-Object System.Net.Sockets.TcpClient; $iar=$client.BeginConnect('%HOST%',$port,$null,$null); $ok=$iar.AsyncWaitHandle.WaitOne(400); if($ok){$client.EndConnect($iar)}; $client.Close() } catch { $ok=$false };" ^
  "    if(-not $ok){$ready=$false}" ^
  "  };" ^
  "  if(-not $ready){Start-Sleep -Milliseconds 500}" ^
  "} while((-not $ready) -and ((Get-Date) -lt $deadline));" ^
  "if(-not $ready){exit 2}"

if errorlevel 2 goto :nodes_indisponiveis

echo [OK] Nodes disponiveis.
echo [ABRINDO] Supervisor INT - http://%HOST%:%INT_PORT%/supervisor-status.html
echo [ABRINDO] Supervisor BR  - http://%HOST%:%BR_PORT%/supervisor-status.html

start "" "http://%HOST%:%INT_PORT%/supervisor-status.html"
start "" "http://%HOST%:%BR_PORT%/supervisor-status.html"
exit /b 0

:nodes_indisponiveis
echo.
echo [ERRO] Um ou ambos os Nodes nao ficaram disponiveis em %WAIT_SECONDS% segundos.
echo        Node INT esperado em http://%HOST%:%INT_PORT%
echo        Node BR  esperado em http://%HOST%:%BR_PORT%
echo.
echo Verifique as abas "Node INT" e "Node BR" da stack antes de abrir os Supervisores.
pause
exit /b 1
