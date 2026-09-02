. (Join-Path $PSScriptRoot 'Common.ps1')

Write-Section 'BAC BO | DIAGNOSTICO'

try {
    $info = Get-BacboInstallInfo
} catch {
    Write-Host ('[ERRO] ' + $_.Exception.Message) -ForegroundColor Red
    exit 2
}

$root = [string]$info.root
$expected = [string]$info.commit
$profile = [string]$info.profile

$checks = New-Object System.Collections.Generic.List[object]

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $checks.Add([pscustomobject]@{ Name=$Name; Ok=$Ok; Detail=$Detail })
}

Add-Check 'INT runtime' (Test-Path -LiteralPath (Join-Path $root 'INT\robo-bacbo\start.js')) 'start.js'
Add-Check 'BR runtime' (Test-Path -LiteralPath (Join-Path $root 'BR\robo-bacbo\start.js')) 'start.js'
Add-Check '.env INT' (Test-Path -LiteralPath (Join-Path $root 'INT\.env')) 'privado'
Add-Check '.env BR' (Test-Path -LiteralPath (Join-Path $root 'BR\.env')) 'privado'

$garnetExe = @(
    Get-ChildItem -LiteralPath (Join-Path $root 'garnet\bin') -Filter 'GarnetServer.exe' -File -Recurse -ErrorAction SilentlyContinue
)
Add-Check 'Garnet binario' ($garnetExe.Count -gt 0) $(if ($garnetExe.Count -gt 0) { $garnetExe[0].FullName } else { 'ausente' })

$garnetData = Join-Path $root 'garnet\data'
Add-Check 'Garnet data' (Test-Path -LiteralPath $garnetData) $garnetData

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeDetail = 'ausente'
if ($null -ne $node) {
    $nodeLines = @(& node.exe --version 2>$null)
    if ($nodeLines.Count -gt 0) { $nodeDetail = ([string]$nodeLines[0]).Trim() }
}
Add-Check 'Node.js' ($null -ne $node) $nodeDetail

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
$wtDetail = if ($null -ne $wt) {
    $wt.Source
}
else {
    'ausente'
}
Add-Check 'Windows Terminal' ($null -ne $wt) $wtDetail

$venvPython = Join-Path $root 'python\venv\Scripts\python.exe'
Add-Check 'Python venv' (Test-Path -LiteralPath $venvPython) $venvPython

if (Test-Path -LiteralPath $venvPython) {
    $probeScript = Join-Path $root 'tools\python-env-probe.py'

    if (-not (Test-Path -LiteralPath $probeScript)) {
        Add-Check 'Imports Python' $false 'python-env-probe.py ausente'
    }
    else {
        $previousPreference = $ErrorActionPreference

        try {
            $ErrorActionPreference = 'Continue'
            $probeOutput = @(& $venvPython $probeScript 2>&1)
            $probeCode = [int]$LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousPreference
        }

        if ($probeCode -eq 0) {
            Add-Check 'Imports Python' $true 'probe real PASS'
        }
        else {
            Write-Host ''
            Write-Host '----- PYTHON ENV PROBE -----' -ForegroundColor Red

            foreach ($line in $probeOutput) {
                Write-Host ([string]$line) -ForegroundColor Red
            }

            Add-Check 'Imports Python' $false ('probe falhou | codigo=' + $probeCode)
        }
    }
}

if ($profile -eq 'SINCRONIZADA_PRODUCAO') {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    $gitOk = $null -ne $git
    Add-Check 'Git' $gitOk $(if ($gitOk) { 'instalado' } else { 'ausente' })

    if ($gitOk) {
        $intRoot = Join-Path $root 'INT'
        $brRoot = Join-Path $root 'BR'

        $headIntLines = @(git -C $intRoot rev-parse HEAD 2>$null)
        $headInt = if ($headIntLines.Count -eq 1) { ([string]$headIntLines[0]).Trim() } else { '' }
        $headBrLines = @(git -C $brRoot rev-parse HEAD 2>$null)
        $headBr = if ($headBrLines.Count -eq 1) { ([string]$headBrLines[0]).Trim() } else { '' }

        $branchIntLines = @(git -C $intRoot rev-parse --abbrev-ref HEAD 2>$null)
        $branchInt = if ($branchIntLines.Count -eq 1) { ([string]$branchIntLines[0]).Trim() } else { '' }
        $branchBrLines = @(git -C $brRoot rev-parse --abbrev-ref HEAD 2>$null)
        $branchBr = if ($branchBrLines.Count -eq 1) { ([string]$branchBrLines[0]).Trim() } else { '' }

        $statusInt = @(git -C $intRoot status --porcelain=v1 2>$null)
        $statusBr = @(git -C $brRoot status --porcelain=v1 2>$null)

        Add-Check 'Git INT SHA' ($headInt -eq $expected) $headInt
        Add-Check 'Git BR SHA' ($headBr -eq $expected) $headBr
        Add-Check 'Git INT branch' ($branchInt -eq 'main') $branchInt
        Add-Check 'Git BR detached' ($branchBr -eq 'HEAD') $branchBr
        Add-Check 'Git INT limpo' ($statusInt.Count -eq 0) ('alteracoes=' + $statusInt.Count)
        Add-Check 'Git BR limpo' ($statusBr.Count -eq 0) ('alteracoes=' + $statusBr.Count)
    }
} else {
    Add-Check 'Build isolada' ($expected -eq '1899802946f83e2832d4db456fe31c707f92b96e') $expected
}

$dbScript = Join-Path $root 'tools\db-check.js'
if ($null -ne $node -and (Test-Path -LiteralPath $dbScript)) {
    & node.exe $dbScript $root
    $dbOk = $LASTEXITCODE -eq 0
    Add-Check 'MySQL HostGator' $dbOk $(if ($dbOk) { 'SELECT 1 OK' } else { 'falhou' })
}

$redisOnline = Test-RespPing -Port 6379
$redisDetail = if ($redisOnline) {
    '127.0.0.1:6379 | PONG'
} elseif (Test-PortListening 6379) {
    'porta ocupada mas sem PONG'
} else {
    'OFF - normal antes de INICIAR SISTEMA'
}
Add-Check 'Garnet/RESP' (-not (Test-PortListening 6379) -or $redisOnline) $redisDetail

Add-Check 'Porta 3000' $true $(if (Test-PortListening 3000) { 'LISTENING' } else { 'OFF' })
Add-Check 'Porta 3001' $true $(if (Test-PortListening 3001) { 'LISTENING' } else { 'OFF' })

$autoTraderArmFile = Join-Path $root 'runtime\auto-trader.arm'
$fuseDetail = 'OFF | padrao fail-closed'

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
            $fuseDetail = 'ARMADO | proximo INICIAR SISTEMA | one-shot'
        }
        else {
            $fuseDetail = 'ARQUIVO INVALIDO | sera tratado como OFF'
        }
    }
    catch {
        $fuseDetail = 'ARQUIVO INVALIDO | sera tratado como OFF'
    }
}

Add-Check 'Auto-Trader fuse' $true $fuseDetail

Write-Host ''
foreach ($c in $checks) {
    if ($c.Ok) {
        Write-Host ('[OK]   {0,-20} {1}' -f $c.Name, $c.Detail) -ForegroundColor Green
    } else {
        Write-Host ('[ERRO] {0,-20} {1}' -f $c.Name, $c.Detail) -ForegroundColor Red
    }
}

$failed = @($checks | Where-Object { -not $_.Ok })
Write-Host ''
if ($failed.Count -eq 0) {
    Write-Host 'DIAGNOSTICO APROVADO.' -ForegroundColor Green
    exit 0
}

Write-Host ('DIAGNOSTICO COM ' + $failed.Count + ' FALHA(S).') -ForegroundColor Red
exit 3
