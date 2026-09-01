param(
    [string]$Root = 'D:\Projetos\Bacbo'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$atalhos = Join-Path $Root 'atalhos'
$window = 'BACBO-OPERACIONAL'

$tabs = [ordered]@{
    'Garnet'      = Join-Path $atalhos '01_GARNET.cmd'
    'Node INT'    = Join-Path $atalhos '03_NODE_INT.cmd'
    'Node BR'     = Join-Path $atalhos '05_NODE_BR.cmd'
    'Coletor INT' = Join-Path $atalhos '02_COLETOR_INT.cmd'
    'Coletor BR'  = Join-Path $atalhos '04_COLETOR_BR.cmd'
}

foreach ($path in $tabs.Values) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "ATALHO_OPERACIONAL_AUSENTE: $path"
    }
}

if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    throw 'WINDOWS_TERMINAL_NAO_ENCONTRADO'
}

function Test-TcpPort([int]$Port) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $task = $client.ConnectAsync('127.0.0.1', $Port)
            if (-not $task.Wait(500)) { return $false }
            return $client.Connected
        }
        finally {
            $client.Dispose()
        }
    }
    catch {
        return $false
    }
}

function Wait-TcpPort([int]$Port, [string]$Name, [int]$TimeoutSeconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort -Port $Port) {
            Write-Host "[OK] $Name pronto em 127.0.0.1:$Port" -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 350
    }
    throw "BOOT_TIMEOUT: $Name nao respondeu na porta $Port em ${TimeoutSeconds}s"
}

function Open-Tab([string]$Title, [string]$CommandPath, [bool]$First = $false) {
    $cmdArg = '"{0}"' -f $CommandPath
    $args = @('-w', $window, 'new-tab', '--title', $Title, '--suppressApplicationTitle', 'cmd.exe', '/k', $cmdArg)
    & wt.exe @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "WT_TAB_FAILED: $Title | exit=$LASTEXITCODE"
    }
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' BACBO | BOOT OPERACIONAL ORDENADO' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan

Write-Host '[1/5] Garnet...'
Open-Tab -Title 'Garnet' -CommandPath $tabs['Garnet'] -First $true
Wait-TcpPort -Port 6379 -Name 'Garnet' -TimeoutSeconds 45

Write-Host '[2/5] Node INT...'
Open-Tab -Title 'Node INT' -CommandPath $tabs['Node INT']
Wait-TcpPort -Port 3000 -Name 'Node INT' -TimeoutSeconds 60
Start-Sleep -Seconds 2

Write-Host '[3/5] Node BR...'
Open-Tab -Title 'Node BR' -CommandPath $tabs['Node BR']
Wait-TcpPort -Port 3001 -Name 'Node BR' -TimeoutSeconds 60
Start-Sleep -Seconds 2

Write-Host '[4/5] Coletor INT...'
Open-Tab -Title 'Coletor INT' -CommandPath $tabs['Coletor INT']
Start-Sleep -Milliseconds 700

Write-Host '[5/5] Coletor BR...'
Open-Tab -Title 'Coletor BR' -CommandPath $tabs['Coletor BR']

Write-Host '[OK] Stack operacional solicitada na ordem correta.' -ForegroundColor Green
