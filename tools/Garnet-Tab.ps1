param(
    [Parameter(Mandatory=$true)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Common.ps1')

$runtimeDir = Join-Path $Root 'runtime'
$systemStopFile = Join-Path $runtimeDir 'system.stop'
$logRoot = Join-Path $Root 'logs\garnet'
$supervisorLog = Join-Path $logRoot 'supervisor.log'
$instanceRoot = Join-Path $logRoot 'instances'

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host 'BAC BO | GARNET' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host 'Runtime................... Garnet 2.1.5'
Write-Host 'RESP...................... 127.0.0.1:6379'
Write-Host 'Persistencia.............. AOF + Recover'
Write-Host ("Dados..................... {0}" -f (Join-Path $Root 'garnet\data'))
Write-Host ("Logs...................... {0}" -f $instanceRoot)
Write-Host ''
Write-Host 'Esta aba acompanha o Supervisor; o processo Garnet fica oculto.' -ForegroundColor DarkGray
Write-Host ''

$lastLineCount = 0
$lastOnline = $null

while (-not (Test-Path -LiteralPath $systemStopFile)) {
    $online = Test-RespPing -Port 6379

    if ($null -eq $lastOnline -or $online -ne $lastOnline) {
        if ($online) {
            $owner = Get-PortOwner 6379

            Write-Host (
                '{0} | GARNET ONLINE | PONG | PID={1}' -f
                (Get-Date -Format 'HH:mm:ss'),
                $owner
            ) -ForegroundColor Green
        }
        else {
            Write-Host (
                '{0} | GARNET OFFLINE / REINICIANDO' -f
                (Get-Date -Format 'HH:mm:ss')
            ) -ForegroundColor Yellow
        }

        $lastOnline = $online
    }

    if (Test-Path -LiteralPath $supervisorLog) {
        $lines = @(
            Get-Content `
                -LiteralPath $supervisorLog `
                -ErrorAction SilentlyContinue
        )

        if ($lines.Count -lt $lastLineCount) {
            $lastLineCount = 0
        }

        if ($lines.Count -gt $lastLineCount) {
            for ($i = $lastLineCount; $i -lt $lines.Count; $i++) {
                $line = [string]$lines[$i]

                if ($line -match 'GARNET_EXITED_UNEXPECTEDLY|GARNET_START_FAILED') {
                    Write-Host $line -ForegroundColor Red
                }
                elseif ($line -match 'GARNET_READY|SUPERVISOR_V2_START') {
                    Write-Host $line -ForegroundColor Green
                }
                else {
                    Write-Host $line
                }
            }

            $lastLineCount = $lines.Count
        }
    }

    Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Host 'Encerramento solicitado pelo PARAR SISTEMA.' -ForegroundColor Yellow
