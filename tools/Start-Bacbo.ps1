. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$root = [string]$info.root
$runtimeDir = Join-Path $root 'runtime'
$gateDir = Join-Path $runtimeDir 'gates'
$sessionFile = Join-Path $runtimeDir 'session.json'
$systemStopFile = Join-Path $runtimeDir 'system.stop'
$garnetStopFile = Join-Path $runtimeDir 'garnet-supervisor.stop'
$autoTraderArmFile = Join-Path $runtimeDir 'auto-trader.arm'

Write-Section 'BAC BO | INICIAR SISTEMA'

if (Test-Path -LiteralPath $sessionFile) {
    throw 'SESSAO_BACBO_JA_REGISTRADA: use PARAR SISTEMA primeiro'
}

foreach ($port in @(3000, 3001, 6379)) {
    if (Test-PortListening $port) {
        $owner = Get-PortOwner $port
        throw "PORTA_JA_OCUPADA: $port | PID=$owner"
    }
}

$wtCommand = Get-Command wt.exe -ErrorAction SilentlyContinue

if ($null -eq $wtCommand) {
    throw 'WINDOWS_TERMINAL_WT_EXE_NAO_ENCONTRADO'
}

$runner = Join-Path $root 'tools\Module-Tab.ps1'
$supervisorScript = Join-Path $root 'tools\Garnet-Supervisor.ps1'
$garnetTab = Join-Path $root 'tools\Garnet-Tab.ps1'
$traderTab = Join-Path $root 'tools\Trader-Tab.ps1'

foreach ($required in @($runner, $supervisorScript, $garnetTab, $traderTab)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "RUNTIME_TOOL_AUSENTE: $required"
    }
}

New-Item `
    -ItemType Directory `
    -Force `
    -Path $runtimeDir |
    Out-Null

$autoTraderFuse = 'OFF'

if (Test-Path -LiteralPath $autoTraderArmFile) {
    try {
        $armRecord = Get-Content `
            -LiteralPath $autoTraderArmFile `
            -Raw |
            ConvertFrom-Json

        if (
            ([string]$armRecord.state).Trim().ToUpperInvariant() -eq 'ARMED' -and
            [bool]$armRecord.one_shot
        ) {
            $autoTraderFuse = 'ON'
        }
    }
    catch {
        $autoTraderFuse = 'OFF'
    }

    # ONE-SHOT: consumido antes de iniciar qualquer modulo.
    Remove-Item `
        -LiteralPath $autoTraderArmFile `
        -Force `
        -ErrorAction SilentlyContinue
}

$traderTitle = if ($autoTraderFuse -eq 'ON') {
    'Trader ON'
}
else {
    'Trader OFF'
}

if (Test-Path -LiteralPath $gateDir) {
    Remove-Item `
        -LiteralPath $gateDir `
        -Recurse `
        -Force
}

New-Item `
    -ItemType Directory `
    -Path $gateDir |
    Out-Null

Remove-Item `
    -LiteralPath $systemStopFile, $garnetStopFile `
    -Force `
    -ErrorAction SilentlyContinue

Get-ChildItem `
    -LiteralPath $runtimeDir `
    -Filter 'module-*.json' `
    -File `
    -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$session = [ordered]@{
    started_at = (Get-Date).ToString('o')
    root = $root
    auto_trader = $autoTraderFuse
    auto_trader_scope = 'BACBO_INT'
    auto_trader_one_shot = $true
    garnet_supervisor_pid = $null
    terminal_launched = $false
}

function Save-Session {
    $session |
        ConvertTo-Json -Depth 5 |
        Set-Content `
            -LiteralPath $sessionFile `
            -Encoding UTF8
}

function Invoke-StopRollback {
    $stopScript = Join-Path $root 'tools\Stop-Bacbo.ps1'

    if (-not (Test-Path -LiteralPath $stopScript)) {
        return
    }

    $previous = $ErrorActionPreference

    try {
        $ErrorActionPreference = 'Continue'

        & powershell.exe `
            -NoLogo `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $stopScript
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

try {
    if ($autoTraderFuse -eq 'ON') {
        Write-Host (
            '[0/4] Auto-Trader fuse........ ON | BACBO_INT | one-shot'
        ) -ForegroundColor Yellow
    }
    else {
        Write-Host (
            '[0/4] Auto-Trader fuse........ OFF | BACBO_INT | one-shot'
        ) -ForegroundColor Green
    }

    if ($autoTraderFuse -eq 'ON') {
        Write-Host '      ATENCAO | Node INT sera iniciado com AUTO_TRADER_ENABLED=true.' -ForegroundColor Yellow
        Write-Host '      Executor financeiro nao e iniciado por este launcher.' -ForegroundColor Yellow
    }
    else {
        Write-Host '      Node INT sera iniciado com AUTO_TRADER_ENABLED=false.' -ForegroundColor Green
    }

    Write-Host '[1/4] Garnet Supervisor...'

    $supervisor = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList @(
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', ('"' + $supervisorScript + '"'),
            '-Root', ('"' + $root + '"')
        ) `
        -WindowStyle Hidden `
        -PassThru

    $session.garnet_supervisor_pid = [int]$supervisor.Id
    Save-Session

    if (-not (Wait-RespPing -Port 6379 -TimeoutSeconds 60)) {
        throw 'GARNET_NAO_RESPONDEU_PONG_EM_60S'
    }

    Write-Host (
        '      OK | 127.0.0.1:6379 | PONG | Supervisor PID={0}' -f
        $supervisor.Id
    ) -ForegroundColor Green

    Write-Host '[2/4] Abrindo uma unica janela Windows Terminal...'

    $wtExe = $wtCommand.Source

    $wtArgs = @(
        '-w', 'new',

        'new-tab',
        '--title', 'Garnet',
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $garnetTab,
        '-Root', $root,

        ';',

        'new-tab',
        '--title', 'Node BR',
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runner,
        '-Root', $root,
        '-Module', 'node-br',
        '-AutoTraderFuse', $autoTraderFuse,

        ';',

        'new-tab',
        '--title', 'Node INT',
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runner,
        '-Root', $root,
        '-Module', 'node-int',
        '-AutoTraderFuse', $autoTraderFuse,

        ';',

        'new-tab',
        '--title', 'Coletor BR',
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runner,
        '-Root', $root,
        '-Module', 'collector-br',
        '-AutoTraderFuse', $autoTraderFuse,

        ';',

        'new-tab',
        '--title', 'Coletor INT',
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runner,
        '-Root', $root,
        '-Module', 'collector-int',
        '-AutoTraderFuse', $autoTraderFuse,

        ';',

        'new-tab',
        '--title', $traderTitle,
        '--suppressApplicationTitle',
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $traderTab,
        '-Root', $root,
        '-State', $autoTraderFuse
    )

    & $wtExe @wtArgs

    if ($LASTEXITCODE -ne 0) {
        throw "WINDOWS_TERMINAL_FALHOU: codigo=$LASTEXITCODE"
    }

    $session.terminal_launched = $true
    Save-Session

    Write-Host ("      OK | abas: Garnet | Node BR | Node INT | Coletor BR | Coletor INT | {0}" -f $traderTitle) -ForegroundColor Green

    Write-Host '[3/4] Aguardando bootstrap serializado dos Nodes...'

    $nodeIntGate = Join-Path $gateDir 'node-int.ready'
    $nodeBrGate = Join-Path $gateDir 'node-br.ready'
    $deadline = (Get-Date).AddSeconds(240)

    while ((Get-Date) -lt $deadline) {
        if (
            (Test-Path -LiteralPath $nodeIntGate) -and
            (Test-Path -LiteralPath $nodeBrGate)
        ) {
            break
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not (Test-Path -LiteralPath $nodeIntGate)) {
        throw 'NODE_INT_GATE_NAO_LIBERADO'
    }

    if (-not (Test-Path -LiteralPath $nodeBrGate)) {
        throw 'NODE_BR_GATE_NAO_LIBERADO'
    }

    Write-Host '      OK | Node INT pronto -> Node BR pronto' -ForegroundColor Green

    Write-Host '[4/4] Dois Nodes prontos; liberando e aguardando os coletores...'

    $collectorIntPid = Join-Path $runtimeDir 'module-collector-int.json'
    $collectorBrPid = Join-Path $runtimeDir 'module-collector-br.json'
    $collectorDeadline = (Get-Date).AddSeconds(60)

    while ((Get-Date) -lt $collectorDeadline) {
        if (
            (Test-Path -LiteralPath $collectorIntPid) -and
            (Test-Path -LiteralPath $collectorBrPid)
        ) {
            break
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not (Test-Path -LiteralPath $collectorIntPid)) {
        throw 'COLETOR_INT_NAO_REGISTROU_PID'
    }

    if (-not (Test-Path -LiteralPath $collectorBrPid)) {
        throw 'COLETOR_BR_NAO_REGISTROU_PID'
    }

    Write-Host '      OK | Coletor INT + Coletor BR iniciados' -ForegroundColor Green

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host 'BAC BO | SISTEMA INICIADO' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host 'Janela................. Windows Terminal unica'
    Write-Host ("Abas................... Garnet | Node BR | Node INT | Coletor BR | Coletor INT | {0}" -f $traderTitle)
    Write-Host 'Bootstrap.............. Garnet -> Node INT -> Node BR -> somente entao Coletores'
    Write-Host ("Auto-Trader............ {0} | BACBO_INT | one-shot" -f $autoTraderFuse)
}
catch {
    Write-Host ''
    Write-Host 'STARTUP INTERROMPIDO EM FAIL-CLOSED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Rollback direcionado dos PIDs desta sessao...' -ForegroundColor Yellow

    Invoke-StopRollback
    throw
}
