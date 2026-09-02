@echo off
setlocal EnableExtensions
set "URL=http://127.0.0.1:3010/accesses"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(30);" ^
  "do {" ^
  "  try {" ^
  "    $client=[System.Net.Sockets.TcpClient]::new();" ^
  "    $task=$client.ConnectAsync('127.0.0.1',3010);" ^
  "    $ok=$task.Wait(400) -and $client.Connected;" ^
  "    $client.Dispose();" ^
  "  } catch { $ok=$false };" ^
  "  if(-not $ok){Start-Sleep -Milliseconds 400}" ^
  "} while((-not $ok) -and ((Get-Date) -lt $deadline));" ^
  "if(-not $ok){exit 2}"

if errorlevel 2 goto :indisponivel
start "" "%URL%"
exit /b 0

:indisponivel
echo [ERRO] Portal universal de Acessos nao respondeu em 127.0.0.1:3010.
echo        Verifique a aba "Acessos" da stack completa.
pause
exit /b 1
