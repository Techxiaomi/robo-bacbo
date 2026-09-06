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
Write-Host '[GARNET] MONITOR | bind=127.0.0.1 | port=6379 | persistence=AOF+Recover' -ForegroundColor Cyan
Write-Host ''

$existingLines = @()

if (Test-Path -LiteralPath $supervisorLog) {
    $existingLines = @(
        Get-Content `
            -LiteralPath $supervisorLog `
            -ErrorAction SilentlyContinue
    )
}

$lastStartIndex = -1

for ($i = 0; $i -lt $existingLines.Count; $i++) {
    if (
        [string]$existingLines[$i] -match
        '^\[GARNET\] START \|'
    ) {
        $lastStartIndex = $i
    }
}

if ($lastStartIndex -ge 0) {
    $lastLineCount = $lastStartIndex
}
else {
    $lastLineCount = $existingLines.Count
}

while (-not (Test-Path -LiteralPath $systemStopFile)) {
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

                if ($line -match 'START_FAILED') {
                    Write-Host $line -ForegroundColor Red
                }
                elseif ($line -match 'RESTART') {
                    Write-Host $line -ForegroundColor Yellow
                }
                elseif ($line -match 'READY') {
                    Write-Host $line -ForegroundColor Green
                }
                elseif ($line -match 'START') {
                    Write-Host $line -ForegroundColor Cyan
                }
                elseif ($line -match 'STOPPED') {
                    Write-Host $line -ForegroundColor Yellow
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
Write-Host '[GARNET] STOPPED | reason=system_stop' -ForegroundColor Yellow
