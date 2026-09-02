. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$root = [string]$info.root
$runtimeDir = Join-Path $root 'runtime'
$sessionFile = Join-Path $runtimeDir 'session.json'
$armFile = Join-Path $runtimeDir 'auto-trader.arm'
$stopScript = Join-Path $root 'tools\Stop-Bacbo.ps1'

Write-Section 'BAC BO | AUTO-TRADER | FUSIVEL OFF'

Remove-Item `
    -LiteralPath $armFile `
    -Force `
    -ErrorAction SilentlyContinue

$activeAndArmed = $false

if (Test-Path -LiteralPath $sessionFile) {
    try {
        $session = Get-Content `
            -LiteralPath $sessionFile `
            -Raw |
            ConvertFrom-Json

        $activeAndArmed = (
            [string]$session.auto_trader
        ).Trim().ToUpperInvariant() -eq 'ON'
    }
    catch {
        Write-Warning 'session.json nao pode ser lido com seguranca.'
        $activeAndArmed = $true
    }
}

if ($activeAndArmed) {
    Write-Host 'Runtime atual estava com fusivel ON.' -ForegroundColor Yellow
    Write-Host 'Para garantir desligamento real, o sistema sera encerrado agora.' -ForegroundColor Yellow
    Write-Host ''

    if (-not (Test-Path -LiteralPath $stopScript)) {
        Write-Host 'ERRO: Stop-Bacbo.ps1 ausente.' -ForegroundColor Red
        exit 30
    }

    & powershell.exe `
        -NoLogo `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $stopScript

    if ($LASTEXITCODE -ne 0) {
        Write-Host (
            'ERRO: PARAR SISTEMA retornou codigo {0}.' -f
            $LASTEXITCODE
        ) -ForegroundColor Red

        exit 31
    }
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'AUTO-TRADER | FUSIVEL OFF' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'Token de armamento........ AUSENTE'
Write-Host 'Persistencia em .env...... NAO'
Write-Host 'Proximo startup........... OFF'
