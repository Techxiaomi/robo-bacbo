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

function Log([string]$Message) {
    $line = (
        '{0} | {1}' -f
        (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'),
        $Message
    )

    Add-Content `
        -LiteralPath $supervisorLog `
        -Value $line `
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

Log 'SUPERVISOR_V2_START'
Log ('GARNET_EXE=' + $exe)
Log ('DATA_ROOT=' + $dataRoot)
Log ('COMMAND=' + $commandLineForLog)

while (-not (Test-Path -LiteralPath $stopFile)) {
    if (Test-PortListening 6379) {
        $owner = Get-PortOwner 6379

        Log (
            'PORT_6379_OCUPADA | PID={0} | aguardando 2s' -f
            $owner
        )

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

    Log (
        'GARNET_STARTING | attempt={0} | stdout={1} | stderr={2}' -f
        $attempt,
        $stdout,
        $stderr
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

        Log (
            'GARNET_START_FAILED | attempt={0} | PID={1} | ExitCode={2} | stdout={3} | stderr={4}' -f
            $attempt,
            $proc.Id,
            $(if ($null -eq $exitCode) { '<running>' } else { $exitCode }),
            $stdout,
            $stderr
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

    Log (
        'GARNET_READY | attempt={0} | PID={1} | stdout={2} | stderr={3}' -f
        $attempt,
        $proc.Id,
        $stdout,
        $stderr
    )

    while (
        -not $proc.HasExited -and
        -not (Test-Path -LiteralPath $stopFile)
    ) {
        Start-Sleep -Seconds 1
        $proc.Refresh()
    }

    if (Test-Path -LiteralPath $stopFile) {
        Log (
            'STOP_REQUESTED | attempt={0} | PID={1}' -f
            $attempt,
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

    Log (
        'GARNET_EXITED_UNEXPECTEDLY | attempt={0} | PID={1} | ExitCode={2} | lifetime_s={3} | stdout={4} | stderr={5} | RESTART_IN_2S' -f
        $attempt,
        $proc.Id,
        $(if ($null -eq $exitCode) { '<unknown>' } else { $exitCode }),
        $lifetimeSeconds,
        $stdout,
        $stderr
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

Log 'SUPERVISOR_V2_STOP'
