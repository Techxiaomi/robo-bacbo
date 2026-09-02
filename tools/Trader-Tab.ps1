param(
    [Parameter(Mandatory=$true)]
    [string]$Root,

    [Parameter(Mandatory=$true)]
    [ValidateSet('ON', 'OFF')]
    [string]$State
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Common.ps1')

$runtimeDir = Join-Path $Root 'runtime'
$systemStopFile = Join-Path $runtimeDir 'system.stop'
$sessionFile = Join-Path $runtimeDir 'session.json'

$expectedEnabled = ($State -eq 'ON')
$lastNodeIntOnline = $null
$lastSessionState = $null

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ("BAC BO | TRADER {0}" -f $State) -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ("Estado.................... {0}" -f $State)
Write-Host 'Mesa financeira........... BACBO_INT'
Write-Host 'Node INT.................. 127.0.0.1:3000'
Write-Host 'Node BR................... BLOQUEADO / FORA DO ESCOPO'
Write-Host ("AUTO_TRADER_ENABLED....... {0}" -f $(if ($expectedEnabled) { 'true' } else { 'false' }))
Write-Host ("Fusivel................... {0}" -f $(if ($expectedEnabled) { 'ONE-SHOT CONSUMIDO NO STARTUP' } else { 'DESARMADO' }))
Write-Host 'Executor financeiro....... NAO INICIADO POR ESTA ABA'
Write-Host 'Fallback HTTP.............. BLOQUEADO'
Write-Host ''
Write-Host 'Esta aba e somente um painel operacional do estado do fusivel.' -ForegroundColor DarkGray
Write-Host 'Ela nao inicia executor e nao executa aposta.' -ForegroundColor DarkGray
Write-Host ''

while (-not (Test-Path -LiteralPath $systemStopFile)) {
    $nodeIntOnline = Test-PortListening 3000

    if ($null -eq $lastNodeIntOnline -or $nodeIntOnline -ne $lastNodeIntOnline) {
        if ($nodeIntOnline) {
            $owner = Get-PortOwner 3000

            Write-Host (
                '{0} | NODE INT ONLINE | PID={1}' -f
                (Get-Date -Format 'HH:mm:ss'),
                $owner
            ) -ForegroundColor Green
        }
        else {
            Write-Host (
                '{0} | NODE INT OFFLINE / INICIALIZANDO' -f
                (Get-Date -Format 'HH:mm:ss')
            ) -ForegroundColor Yellow
        }

        $lastNodeIntOnline = $nodeIntOnline
    }

    if (Test-Path -LiteralPath $sessionFile) {
        try {
            $session = Get-Content `
                -LiteralPath $sessionFile `
                -Raw |
                ConvertFrom-Json

            $sessionState = ([string]$session.auto_trader).Trim().ToUpperInvariant()

            if ($sessionState -ne $lastSessionState) {
                if ($sessionState -eq $State) {
                    Write-Host (
                        '{0} | SESSAO CONFIRMADA | AUTO-TRADER={1} | ESCOPO=BACBO_INT' -f
                        (Get-Date -Format 'HH:mm:ss'),
                        $sessionState
                    ) -ForegroundColor Green
                }
                else {
                    Write-Host (
                        '{0} | ALERTA | sessao={1} | aba={2}' -f
                        (Get-Date -Format 'HH:mm:ss'),
                        $sessionState,
                        $State
                    ) -ForegroundColor Red
                }

                $lastSessionState = $sessionState
            }
        }
        catch {
            if ($lastSessionState -ne '<INVALID>') {
                Write-Host (
                    '{0} | ALERTA | session.json invalido' -f
                    (Get-Date -Format 'HH:mm:ss')
                ) -ForegroundColor Red

                $lastSessionState = '<INVALID>'
            }
        }
    }

    Start-Sleep -Milliseconds 750
}

Write-Host ''
Write-Host 'Encerramento solicitado pelo PARAR SISTEMA.' -ForegroundColor Yellow
