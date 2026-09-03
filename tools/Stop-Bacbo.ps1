. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$root = [string]$info.root
$runtimeDir = Join-Path $root 'runtime'
$sessionFile = Join-Path $runtimeDir 'session.json'
$systemStopFile = Join-Path $runtimeDir 'system.stop'
$garnetStopFile = Join-Path $runtimeDir 'garnet-supervisor.stop'

Write-Section 'BAC BO | PARAR SISTEMA'

New-Item `
    -ItemType Directory `
    -Force `
    -Path $runtimeDir |
    Out-Null

Set-Content `
    -LiteralPath $systemStopFile `
    -Value 'STOP' `
    -Encoding ASCII

function Stop-RegisteredModule {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Module
    )

    $recordPath = Join-Path $runtimeDir ("module-{0}.json" -f $Module)

    if (-not (Test-Path -LiteralPath $recordPath)) {
        Write-Host ("{0} | sem PID registrado." -f $Module)
        return
    }

    try {
        $record = Get-Content `
            -LiteralPath $recordPath `
            -Raw |
            ConvertFrom-Json

        $pidValue = [int]$record.pid
        $expectedExecutable = [string]$record.expected_executable
        $expectedStarted = [datetime]$record.started_at

        $proc = Get-Process `
            -Id $pidValue `
            -ErrorAction SilentlyContinue

        if ($null -eq $proc) {
            Write-Host (
                '{0} | PID {1} ja encerrou.' -f
                $Module,
                $pidValue
            )

            return
        }

        $actualStarted = $proc.StartTime
        $startDiff = [math]::Abs(
            ($actualStarted - $expectedStarted).TotalSeconds
        )

        if ($startDiff -gt 5) {
            Write-Warning (
                '{0} | PID {1} foi reutilizado; nao sera encerrado.' -f
                $Module,
                $pidValue
            )

            return
        }

        if (
            $expectedExecutable -eq 'python.exe' -and
            $proc.ProcessName -notmatch '^python'
        ) {
            Write-Warning (
                '{0} | PID {1} nao e Python; nao sera encerrado.' -f
                $Module,
                $pidValue
            )

            return
        }

        if (
            $expectedExecutable -eq 'cmd.exe' -and
            $proc.ProcessName -ne 'cmd'
        ) {
            Write-Warning (
                '{0} | PID {1} nao e cmd.exe; nao sera encerrado.' -f
                $Module,
                $pidValue
            )

            return
        }

        Write-Host (
            '{0} | encerrando PID {1}...' -f
            $Module,
            $pidValue
        )

        & taskkill.exe `
            /PID $pidValue `
            /T `
            /F |
            Out-Null
    }
    finally {
        Remove-Item `
            -LiteralPath $recordPath `
            -Force `
            -ErrorAction SilentlyContinue
    }
}

foreach ($module in @(
    'collector-br',
    'collector-int',
    'node-br',
    'node-int'
)) {
    Stop-RegisteredModule -Module $module
}

Write-Host 'Garnet Supervisor | solicitando parada...'

Set-Content `
    -LiteralPath $garnetStopFile `
    -Value 'STOP' `
    -Encoding ASCII

$deadline = (Get-Date).AddSeconds(20)

while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortListening 6379)) {
        break
    }

    Start-Sleep -Milliseconds 500
}

$session = $null

if (Test-Path -LiteralPath $sessionFile) {
    try {
        $session = Get-Content `
            -LiteralPath $sessionFile `
            -Raw |
            ConvertFrom-Json
    }
    catch {
        Write-Warning 'session.json invalido; supervisor nao sera morto por PID sem validacao.'
    }
}

if (
    $null -ne $session -and
    $null -ne $session.garnet_supervisor_pid
) {
    $supervisorPid = [int]$session.garnet_supervisor_pid

    $sup = Get-CimInstance `
        Win32_Process `
        -Filter ("ProcessId = {0}" -f $supervisorPid) `
        -ErrorAction SilentlyContinue

    if (
        $null -ne $sup -and
        $sup.Name -eq 'powershell.exe' -and
        [string]$sup.CommandLine -like '*Garnet-Supervisor.ps1*'
    ) {
        $supervisorDeadline = (Get-Date).AddSeconds(10)

        while ((Get-Date) -lt $supervisorDeadline) {
            $stillThere = Get-Process `
                -Id $supervisorPid `
                -ErrorAction SilentlyContinue

            if ($null -eq $stillThere) {
                break
            }

            Start-Sleep -Milliseconds 500
        }

        $stillThere = Get-Process `
            -Id $supervisorPid `
            -ErrorAction SilentlyContinue

        if ($null -ne $stillThere) {
            Stop-Process `
                -Id $supervisorPid `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }
}

if (Test-PortListening 6379) {
    Write-Warning 'A porta 6379 continua ativa apos a parada solicitada.'
}
else {
    Write-Host 'Garnet................. OFF' -ForegroundColor Green
}

Remove-Item `
    -LiteralPath $sessionFile `
    -Force `
    -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath (Join-Path $runtimeDir 'gates')) {
    Remove-Item `
        -LiteralPath (Join-Path $runtimeDir 'gates') `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
}

Remove-Item `
    -LiteralPath $systemStopFile, $garnetStopFile `
    -Force `
    -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Sistema encerrado.' -ForegroundColor Green
