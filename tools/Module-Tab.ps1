param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('node-br', 'node-int', 'collector-br', 'collector-int')]
    [string]$Module,

    [Parameter(Mandatory=$true)]
    [string]$Root,

    [ValidateSet('ON', 'OFF')]
    [string]$AutoTraderFuse = 'OFF'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Common.ps1')

$runtimeDir = Join-Path $Root 'runtime'
$gateDir = Join-Path $runtimeDir 'gates'
$systemStopFile = Join-Path $runtimeDir 'system.stop'

New-Item `
    -ItemType Directory `
    -Force `
    -Path $runtimeDir, $gateDir |
    Out-Null

function Wait-Gate {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path,

        [Parameter(Mandatory=$true)]
        [string]$Description,

        [int]$TimeoutSeconds = 240
    )

    Write-Host ("Aguardando: {0}" -f $Description) -ForegroundColor Yellow

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $systemStopFile) {
            throw 'SYSTEM_STOP_REQUESTED'
        }

        if (Test-Path -LiteralPath $Path) {
            Write-Host ("Gate liberado: {0}" -f $Description) -ForegroundColor Green
            return
        }

        Start-Sleep -Milliseconds 500
    }

    throw ("GATE_TIMEOUT: {0}" -f $Description)
}

function Write-ModulePid {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Name,

        [Parameter(Mandatory=$true)]
        $ProcessObject,

        [Parameter(Mandatory=$true)]
        [string]$ExpectedExecutable
    )

    $path = Join-Path $runtimeDir ("module-{0}.json" -f $Name)

    $record = [ordered]@{
        module = $Name
        pid = [int]$ProcessObject.Id
        expected_executable = $ExpectedExecutable
        started_at = $ProcessObject.StartTime.ToString('o')
    }

    $record |
        ConvertTo-Json -Depth 5 |
        Set-Content `
            -LiteralPath $path `
            -Encoding UTF8

    return $path
}

function Wait-ProcessAndHandleExit {
    param(
        [Parameter(Mandatory=$true)]
        $ProcessObject,

        [Parameter(Mandatory=$true)]
        [string]$PidRecord
    )

    $ProcessObject.WaitForExit()
    $exitCode = [int]$ProcessObject.ExitCode

    Remove-Item `
        -LiteralPath $PidRecord `
        -Force `
        -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $systemStopFile) {
        Write-Host 'Encerramento solicitado pelo PARAR SISTEMA.'
        exit 0
    }

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host 'MODULO ENCERROU INESPERADAMENTE' -ForegroundColor Red
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host ("Modulo.... {0}" -f $Module)
    Write-Host ("ExitCode.. {0}" -f $exitCode)
    Write-Host ''

    Read-Host 'Pressione ENTER para fechar esta aba'
    exit $exitCode
}

$nodeIntGate = Join-Path $gateDir 'node-int.ready'
$nodeBrGate = Join-Path $gateDir 'node-br.ready'

$moduleInfo = switch ($Module) {
    'node-int' {
        [pscustomobject]@{
            Display = 'Node INT'
            Mesa = 'BACBO_INT'
            NodePort = 3000
            TipMiner = 'cc71e81d-8b56-4868-91c7-7224be543dce'
            WorkDir = Join-Path $Root 'INT\robo-bacbo'
            WaitGate = $null
            WaitDescription = $null
            ReadyGate = $nodeIntGate
            Type = 'node'
        }
    }

    'node-br' {
        [pscustomobject]@{
            Display = 'Node BR'
            Mesa = 'BACBO_BR'
            NodePort = 3001
            TipMiner = 'daed14c3-2a22-47b3-83c6-2c3a50c2ae69'
            WorkDir = Join-Path $Root 'BR\robo-bacbo'
            WaitGate = $nodeIntGate
            WaitDescription = 'Node INT concluir bootstrap'
            ReadyGate = $nodeBrGate
            Type = 'node'
        }
    }

    'collector-int' {
        [pscustomobject]@{
            Display = 'Coletor INT'
            Mesa = 'BACBO_INT'
            NodePort = 3000
            TipMiner = 'cc71e81d-8b56-4868-91c7-7224be543dce'
            WorkDir = Join-Path $Root 'INT\robo-sync-pilot'
            WaitGate = $nodeBrGate
            WaitDescription = 'Node INT + Node BR concluirem bootstrap'
            ReadyGate = $null
            Type = 'collector'
        }
    }

    'collector-br' {
        [pscustomobject]@{
            Display = 'Coletor BR'
            Mesa = 'BACBO_BR'
            NodePort = 3001
            TipMiner = 'daed14c3-2a22-47b3-83c6-2c3a50c2ae69'
            WorkDir = Join-Path $Root 'BR\robo-sync-pilot'
            WaitGate = $nodeBrGate
            WaitDescription = 'Node INT + Node BR concluirem bootstrap'
            ReadyGate = $null
            Type = 'collector'
        }
    }
}

if (-not (Test-Path -LiteralPath $moduleInfo.WorkDir)) {
    throw ("WORKDIR_NAO_ENCONTRADO: {0}" -f $moduleInfo.WorkDir)
}

$autoTraderEnabled = (
    $Module -eq 'node-int' -and
    $AutoTraderFuse -eq 'ON'
)

$autoTraderLabel = if ($Module -eq 'node-int') {
    if ($autoTraderEnabled) {
        'ON | FUSIVEL ONE-SHOT ARMADO'
    }
    else {
        'OFF'
    }
}
elseif ($Module -eq 'node-br') {
    'OFF | BR FORA DO ESCOPO FINANCEIRO'
}
else {
    'N/A | COLETOR'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ("BAC BO | {0}" -f $moduleInfo.Display) -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ("MODULO................... {0}" -f $Module)
Write-Host ("BACBO_MESA_CODIGO........ {0}" -f $moduleInfo.Mesa)
Write-Host ("NODE_PORT................. {0}" -f $moduleInfo.NodePort)
Write-Host ("TIPMINER_ROUND_ID......... {0}" -f $moduleInfo.TipMiner)
Write-Host ("WORKDIR................... {0}" -f $moduleInfo.WorkDir)
Write-Host ("AUTO_TRADER............... {0}" -f $autoTraderLabel)
Write-Host ''

if ($null -ne $moduleInfo.WaitGate) {
    Wait-Gate `
        -Path $moduleInfo.WaitGate `
        -Description $moduleInfo.WaitDescription
}

if (Test-Path -LiteralPath $systemStopFile) {
    throw 'SYSTEM_STOP_REQUESTED'
}

$env:BACBO_MESA_CODIGO = [string]$moduleInfo.Mesa
$env:TIPMINER_BACBO_ROUND_ID = [string]$moduleInfo.TipMiner
$env:NODE_HOST = '127.0.0.1'
$env:NODE_PORT = [string]$moduleInfo.NodePort
$env:PORT = [string]$moduleInfo.NodePort
$env:REDIS_URL = 'redis://127.0.0.1:6379'

if ($autoTraderEnabled) {
    $env:AUTO_TRADER_ENABLED = 'true'
}
else {
    $env:AUTO_TRADER_ENABLED = 'false'
}

# Fallback HTTP financeiro continua deliberadamente morto.
# O executor real, quando utilizado, precisa estar presente no transporte Redis.
$env:EXECUTOR_URL = 'http://127.0.0.1:59998/apostar'

if ($Module -eq 'node-br') {
    $env:BACBO_MESA_RUNTIME_ENABLED = '1'
}
elseif ($Module -eq 'node-int') {
    Remove-Item Env:BACBO_MESA_RUNTIME_ENABLED -ErrorAction SilentlyContinue
}

if ($env:BACBO_MESA_CODIGO -ne $moduleInfo.Mesa) {
    throw 'MESA_ENV_DIVERGENTE'
}

if (
    $Module -eq 'node-br' -and
    $env:AUTO_TRADER_ENABLED -ne 'false'
) {
    throw 'AUTO_TRADER_BR_NAO_PODE_SER_ARMADO'
}

Set-Location -LiteralPath $moduleInfo.WorkDir

if ($moduleInfo.Type -eq 'node') {
    $null = Get-Command npm.cmd -ErrorAction Stop

    $commandText = (
        'cd /d "' +
        $moduleInfo.WorkDir +
        '" && npm start'
    )

    $proc = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList @(
            '/d',
            '/c',
            $commandText
        ) `
        -NoNewWindow `
        -PassThru

    $pidRecord = Write-ModulePid `
        -Name $Module `
        -ProcessObject $proc `
        -ExpectedExecutable 'cmd.exe'

    Write-Host ("PROCESS_PID............... {0}" -f $proc.Id)

    $deadline = (Get-Date).AddSeconds(180)
    $ready = $false

    while ((Get-Date) -lt $deadline) {
        $proc.Refresh()

        if ($proc.HasExited) {
            break
        }

        if (Wait-BackendReady -Port $moduleInfo.NodePort -TimeoutSeconds 2) {
            $ready = $true
            break
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
        if (-not $proc.HasExited) {
            Stop-Process `
                -Id $proc.Id `
                -Force `
                -ErrorAction SilentlyContinue
        }

        Remove-Item `
            -LiteralPath $pidRecord `
            -Force `
            -ErrorAction SilentlyContinue

        throw (
            'NODE_BOOTSTRAP_NAO_FICOU_PRONTO: {0}' -f
            $moduleInfo.Display
        )
    }

    if ($null -ne $moduleInfo.ReadyGate) {
        Set-Content `
            -LiteralPath $moduleInfo.ReadyGate `
            -Value (
                '{0}|{1}|{2}' -f
                $moduleInfo.Mesa,
                $proc.Id,
                (Get-Date).ToString('o')
            ) `
            -Encoding ASCII
    }

    Write-Host ''
    Write-Host (
        '{0} | BACKEND PRONTO | gate liberado.' -f
        $moduleInfo.Display
    ) -ForegroundColor Green
    Write-Host ''

    Wait-ProcessAndHandleExit `
        -ProcessObject $proc `
        -PidRecord $pidRecord
}
else {
    $venvPython = Join-Path $Root 'python\venv\Scripts\python.exe'

    if (-not (Test-Path -LiteralPath $venvPython)) {
        throw ("VENV_NAO_ENCONTRADO: {0}" -f $venvPython)
    }

    $env:PYTHONUNBUFFERED = '1'
    $env:REDIS_URL = 'redis://127.0.0.1:6379/0'

    $collectorScript = Join-Path $moduleInfo.WorkDir 'tipminer_collector.py'

    if (-not (Test-Path -LiteralPath $collectorScript)) {
        throw ("COLETOR_NAO_ENCONTRADO: {0}" -f $collectorScript)
    }

    $proc = Start-Process `
        -FilePath $venvPython `
        -ArgumentList @($collectorScript) `
        -WorkingDirectory $moduleInfo.WorkDir `
        -NoNewWindow `
        -PassThru

    $pidRecord = Write-ModulePid `
        -Name $Module `
        -ProcessObject $proc `
        -ExpectedExecutable 'python.exe'

    Write-Host ("PROCESS_PID............... {0}" -f $proc.Id)
    Write-Host ''

    Wait-ProcessAndHandleExit `
        -ProcessObject $proc `
        -PidRecord $pidRecord
}
