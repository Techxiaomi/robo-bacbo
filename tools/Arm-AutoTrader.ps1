. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$root = [string]$info.root
$runtimeDir = Join-Path $root 'runtime'
$sessionFile = Join-Path $runtimeDir 'session.json'
$armFile = Join-Path $runtimeDir 'auto-trader.arm'

Write-Section 'BAC BO | AUTO-TRADER | FUSIVEL ON'

if (Test-Path -LiteralPath $sessionFile) {
    Write-Host 'RECUSADO: o sistema esta em execucao.' -ForegroundColor Red
    Write-Host 'Use PARAR SISTEMA antes de armar o fusivel.' -ForegroundColor Yellow
    exit 20
}

foreach ($port in @(3000, 3001)) {
    if (Test-PortListening $port) {
        $owner = Get-PortOwner $port

        Write-Host (
            'RECUSADO: porta {0} esta ativa | PID={1}' -f
            $port,
            $owner
        ) -ForegroundColor Red

        exit 21
    }
}

New-Item `
    -ItemType Directory `
    -Force `
    -Path $runtimeDir |
    Out-Null

Write-Host ''
Write-Host 'Este comando NAO inicia o sistema e NAO executa aposta.' -ForegroundColor Yellow
Write-Host 'Ele arma SOMENTE o Node INT para o PROXIMO INICIAR SISTEMA.' -ForegroundColor Yellow
Write-Host 'O armamento e de uso unico e sera consumido no proximo startup.' -ForegroundColor Yellow
Write-Host 'O executor financeiro NAO e iniciado por este atalho.' -ForegroundColor Yellow
Write-Host ''

$confirmation = Read-Host 'Digite exatamente ARMAR para confirmar'

if ($confirmation -cne 'ARMAR') {
    Remove-Item `
        -LiteralPath $armFile `
        -Force `
        -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host 'FUSIVEL CONTINUA OFF.' -ForegroundColor Green
    exit 0
}

$record = [ordered]@{
    state = 'ARMED'
    armed_at = (Get-Date).ToString('o')
    machine = $env:COMPUTERNAME
    one_shot = $true
}

$record |
    ConvertTo-Json -Depth 4 |
    Set-Content `
        -LiteralPath $armFile `
        -Encoding UTF8

Write-Host ''
Write-Host '============================================================' -ForegroundColor Yellow
Write-Host 'AUTO-TRADER ARMADO PARA O PROXIMO START' -ForegroundColor Yellow
Write-Host '============================================================' -ForegroundColor Yellow
Write-Host 'Escopo financeiro......... BACBO_INT'
Write-Host 'Persistencia em .env...... NAO'
Write-Host 'Uso....................... ONE-SHOT'
Write-Host 'Executor.................. NAO INICIADO'
Write-Host ''
Write-Host 'Ao executar INICIAR SISTEMA, o token sera consumido.' -ForegroundColor Yellow
