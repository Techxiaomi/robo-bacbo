param(
    [string]$Root = 'D:\Projetos\Bacbo'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$atalhos = Join-Path $Root 'atalhos'
$shortcutNames = @(
    '01_GARNET.cmd',
    '02_COLETOR_INT.cmd',
    '03_NODE_INT.cmd',
    '04_COLETOR_BR.cmd',
    '05_NODE_BR.cmd',
    '06_MASTER_SUPERVISOR.cmd',
    '07_SIGNAL_ROUTER.cmd',
    '08_ACESSOS_SERVER.cmd'
)

function Get-ProcessSnapshot {
    Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
}

function Stop-ProcessTree([int]$ProcessId, [string]$Label) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return $false }
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }

    Write-Host "[STOP] $Label | PID=$ProcessId" -ForegroundColor Yellow
    & taskkill.exe /PID $ProcessId /T /F *> $null
    return $true
}

function Get-ListeningPid([int]$Port) {
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
            Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    }
    catch {}
    return 0
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' BACBO | ENCERRAMENTO TOTAL PARA MANUTENCAO' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host 'Escopo: somente modulos da stack BACBO e seus processos filhos.' -ForegroundColor DarkGray
Write-Host ''

$stopped = [System.Collections.Generic.HashSet[int]]::new()
$snapshot = @(Get-ProcessSnapshot)

foreach ($shortcut in $shortcutNames) {
    $escaped = [regex]::Escape((Join-Path $atalhos $shortcut))
    $matches = $snapshot | Where-Object {
        $_.Name -ieq 'cmd.exe' -and
        $_.CommandLine -and
        $_.CommandLine -match $escaped
    }

    foreach ($item in $matches) {
        $pidValue = [int]$item.ProcessId
        if ($stopped.Add($pidValue)) {
            [void](Stop-ProcessTree -ProcessId $pidValue -Label $shortcut)
        }
    }
}

Start-Sleep -Milliseconds 800
$snapshot = @(Get-ProcessSnapshot)

$projectPatterns = @(
    'scripts\\master_supervisor\.js',
    'scripts\\signal_router\.js',
    'scripts\\betting_house_api_dev_server\.js',
    'scripts\\run_live_bridge\.js',
    'tipminer_collector\.py',
    'live_bridge\.py',
    'Garnet-Supervisor\.ps1',
    'Garnet-Tab\.ps1',
    'Garnet-Launcher\.ps1'
)

foreach ($item in $snapshot) {
    $commandLine = [string]$item.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }

    $matched = $false
    foreach ($pattern in $projectPatterns) {
        if ($commandLine -match $pattern) {
            $matched = $true
            break
        }
    }
    if (-not $matched) { continue }

    $pidValue = [int]$item.ProcessId
    if ($stopped.Add($pidValue)) {
        [void](Stop-ProcessTree -ProcessId $pidValue -Label ([string]$item.Name))
    }
}

foreach ($port in @(3000, 3001, 3010, 6379)) {
    $ownerPid = Get-ListeningPid -Port $port
    if ($ownerPid -gt 0 -and $stopped.Add($ownerPid)) {
        [void](Stop-ProcessTree -ProcessId $ownerPid -Label "porta $port")
    }
}

Get-Process -Name 'GarnetServer' -ErrorAction SilentlyContinue | ForEach-Object {
    $pidValue = [int]$_.Id
    if ($stopped.Add($pidValue)) {
        [void](Stop-ProcessTree -ProcessId $pidValue -Label 'GarnetServer')
    }
}

Start-Sleep -Seconds 1

$remaining = @()
foreach ($port in @(3000, 3001, 3010, 6379)) {
    $ownerPid = Get-ListeningPid -Port $port
    if ($ownerPid -gt 0) {
        $remaining += "porta $port -> PID $ownerPid"
    }
}

if ($remaining.Count -gt 0) {
    Write-Host ''
    Write-Host '[ATENCAO] Ainda existem listeners da stack:' -ForegroundColor Red
    $remaining | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host '[OK] Stack BACBO encerrada para manutencao.' -ForegroundColor Green
Write-Host '     Portas 3000, 3001, 3010 e 6379 sem listeners.' -ForegroundColor Green
exit 0