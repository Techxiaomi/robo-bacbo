param(
    [string]$Root = 'D:\Projetos\Bacbo'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tools = Join-Path $Root 'tools'
$supervisor = Join-Path $tools 'Garnet-Supervisor.ps1'
$tab = Join-Path $tools 'Garnet-Tab.ps1'

foreach ($required in @($supervisor, $tab)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "GARNET_TOOL_AUSENTE: $required"
    }
}

function Test-GarnetPort {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $task = $client.ConnectAsync('127.0.0.1', 6379)
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

if (-not (Test-GarnetPort)) {
    Write-Host '[GARNET] Iniciando supervisor local...' -ForegroundColor Cyan
    $args = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $supervisor,
        '-Root', $Root
    )

    Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList $args `
        -WindowStyle Hidden | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-GarnetPort) { break }
        Start-Sleep -Milliseconds 300
    }

    if (-not (Test-GarnetPort)) {
        throw 'GARNET_START_TIMEOUT: porta 6379 nao respondeu em 30s'
    }
}

Write-Host '[GARNET] Supervisor ativo; iniciando aba de monitoramento.' -ForegroundColor Green
& powershell.exe `
    -NoLogo `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $tab `
    -Root $Root

if ($LASTEXITCODE -ne 0) {
    throw "GARNET_TAB_EXIT_CODE: $LASTEXITCODE"
}
