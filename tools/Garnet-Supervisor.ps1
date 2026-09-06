param(
    [Parameter(Mandatory=$true)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Common.ps1')

$garnetRoot = Join-Path $Root 'garnet'
$dataRoot = Join-Path $garnetRoot 'data'
$logRoot = Join-Path $Root 'logs\garnet'
$instanceLogRoot = Join-Path $logRoot 'instances'
$runtimeRoot = Join-Path $Root 'runtime'

$stopFile = Join-Path $runtimeRoot 'garnet-supervisor.stop'
$pidFile = Join-Path $runtimeRoot 'garnet.pid'
$supervisorLog = Join-Path $logRoot 'supervisor.log'
$auditLog = Join-Path $logRoot 'supervisor.audit.jsonl'

$exeCandidates = @(
    Get-ChildItem `
        -LiteralPath (Join-Path $garnetRoot 'bin') `
        -Filter 'GarnetServer.exe' `
        -File `
        -Recurse `
        -ErrorAction SilentlyContinue
)

if ($exeCandidates.Count -eq 0) {
    throw 'GARNETSERVER_EXE_NAO_ENCONTRADO'
}

$exe = $exeCandidates[0].FullName

New-Item `
    -ItemType Directory `
    -Force `
    -Path $dataRoot, $logRoot, $instanceLogRoot, $runtimeRoot |
    Out-Null

Remove-Item `
    -LiteralPath $stopFile `
    -Force `
    -ErrorAction SilentlyContinue

$IconReady = [char]0x2705
$IconWarn  = [char]0x26A0
$IconError = [char]0x274C
$IconStop  = [char]0x23F9

function Log([string]$Message) {
    Add-Content `
        -LiteralPath $supervisorLog `
        -Value ('[GARNET] ' + $Message) `
        -Encoding UTF8
}

function Audit(
    [string]$Event,
    [hashtable]$Data = @{}
) {
    $record = [ordered]@{
        timestamp      = (Get-Date).ToString('o')
        event          = $Event
        supervisor_pid = [int]$PID
        bind           = '127.0.0.1'
        port           = 6379
    }

    foreach ($key in $Data.Keys) {
        $record[$key] = $Data[$key]
    }

    $json =
        $record |
        ConvertTo-Json -Compress -Depth 8

    Add-Content `
        -LiteralPath $auditLog `
        -Value $json `
        -Encoding UTF8
}

function Get-ExitCodeSafe($ProcessObject) {
    try {
        $ProcessObject.Refresh()

        if (-not $ProcessObject.HasExited) {
            return $null
        }

        $ProcessObject.WaitForExit()
        return [int]$ProcessObject.ExitCode
    }
    catch {
        return $null
    }
}

$argumentList = @(
    '--bind', '127.0.0.1',
    '--port', '6379',
    '--checkpointdir', $dataRoot,
    '--aof',
    '--aof-commit-freq', '0',
    '--aof-commit-wait',
    '--recover'
)

$commandLineForLog = (
    '"' + $exe + '" ' +
    (($argumentList | ForEach-Object {
        if ([string]$_ -match '\s') {
            '"' + [string]$_ + '"'
        }
        else {
            [string]$_
        }
    }) -join ' ')
)

$attempt = 0

Audit 'SUPERVISOR_START' @{
    exe       = $exe
    data_root = $dataRoot
    command   = $commandLineForLog
}

while (-not (Test-Path -LiteralPath $stopFile)) {
    if (Test-PortListening 6379) {
        $owner = Get-PortOwner 6379

        Audit 'PORT_BUSY' @{
            owner_pid  = $owner
            retry_in_s = 2
        }

        Start-Sleep -Seconds 2
        continue
    }

    $attempt += 1
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $baseName = (
        '{0}-attempt-{1:D4}' -f
        $stamp,
        $attempt
    )

    $stdout = Join-Path $instanceLogRoot ($baseName + '.stdout.log')
    $stderr = Join-Path $instanceLogRoot ($baseName + '.stderr.log')
    $startedAt = Get-Date

    Audit 'GARNET_STARTING' @{
        attempt = $attempt
        stdout  = $stdout
        stderr  = $stderr
    }

    Log (
        'START | attempt={0} | bind=127.0.0.1 | port=6379' -f
        $attempt
    )

    $proc = Start-Process `
        -FilePath $exe `
        -ArgumentList $argumentList `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru

    Set-Content `
        -LiteralPath $pidFile `
        -Value ([string]$proc.Id) `
        -Encoding ASCII

    if (-not (Wait-RespPing -Port 6379 -TimeoutSeconds 45)) {
        $exitCode = Get-ExitCodeSafe $proc

        $exitDisplay =
            $(if ($null -eq $exitCode) { '<running>' } else { $exitCode })

        Audit 'GARNET_START_FAILED' @{
            attempt    = $attempt
            garnet_pid = [int]$proc.Id
            exit_code  = $exitDisplay
            stdout     = $stdout
            stderr     = $stderr
        }

        Log (
            '{0} START_FAILED | attempt={1} | pid={2} | exit={3}' -f
            $IconError,
            $attempt,
            $proc.Id,
            $exitDisplay
        )

        if (-not $proc.HasExited) {
            Stop-Process `
                -Id $proc.Id `
                -Force `
                -ErrorAction SilentlyContinue

            $proc.WaitForExit()
        }

        Remove-Item `
            -LiteralPath $pidFile `
            -Force `
            -ErrorAction SilentlyContinue

        Start-Sleep -Seconds 2
        continue
    }

    Audit 'GARNET_READY' @{
        attempt    = $attempt
        garnet_pid = [int]$proc.Id
        stdout     = $stdout
        stderr     = $stderr
    }

    Log (
        '{0} READY | pid={1} | port=6379 | attempt={2}' -f
        $IconReady,
        $proc.Id,
        $attempt
    )

    while (
        -not $proc.HasExited -and
        -not (Test-Path -LiteralPath $stopFile)
    ) {
        Start-Sleep -Seconds 1
        $proc.Refresh()
    }

    if (Test-Path -LiteralPath $stopFile) {
        Audit 'STOP_REQUESTED' @{
            attempt    = $attempt
            garnet_pid = [int]$proc.Id
        }

        Log (
            '{0} STOPPED | pid={1} | reason=requested' -f
            $IconStop,
            $proc.Id
        )

        if (-not $proc.HasExited) {
            Stop-Process `
                -Id $proc.Id `
                -Force `
                -ErrorAction SilentlyContinue

            try {
                $proc.WaitForExit()
            }
            catch {
            }
        }

        break
    }

    $endedAt = Get-Date
    $lifetimeSeconds = [math]::Round(
        ($endedAt - $startedAt).TotalSeconds,
        3
    )

    $exitCode = Get-ExitCodeSafe $proc

    $exitDisplay =
        $(if ($null -eq $exitCode) { '<unknown>' } else { $exitCode })

    Audit 'GARNET_EXITED_UNEXPECTEDLY' @{
        attempt      = $attempt
        garnet_pid   = [int]$proc.Id
        exit_code    = $exitDisplay
        lifetime_s   = $lifetimeSeconds
        stdout       = $stdout
        stderr       = $stderr
        restart_in_s = 2
    }

    Log (
        '{0} RESTART | attempt={1} | pid={2} | exit={3} | reason=process_exit | in=2s' -f
        $IconWarn,
        $attempt,
        $proc.Id,
        $exitDisplay
    )

    Remove-Item `
        -LiteralPath $pidFile `
        -Force `
        -ErrorAction SilentlyContinue

    Start-Sleep -Seconds 2
}

Remove-Item `
    -LiteralPath $pidFile `
    -Force `
    -ErrorAction SilentlyContinue

Audit 'SUPERVISOR_STOP'
