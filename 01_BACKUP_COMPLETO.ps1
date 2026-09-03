[CmdletBinding()]
param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$OutputDirectory = '',
    [switch]$IncludeDependencies
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step([string]$Message) {
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Read-EnvFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Arquivo .env nao encontrado: $Path" }
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
        $parts = $trimmed -split '=', 2
        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")
        if ($key) { $map[$key] = $value }
    }
    return $map
}

function Find-MariaDbBin {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += Get-ChildItem -LiteralPath $env:ProgramFiles -Directory -Filter 'MariaDB*' -ErrorAction SilentlyContinue }
    if (${env:ProgramFiles(x86)}) { $candidates += Get-ChildItem -LiteralPath ${env:ProgramFiles(x86)} -Directory -Filter 'MariaDB*' -ErrorAction SilentlyContinue }
    foreach ($dir in ($candidates | Sort-Object Name -Descending)) {
        $bin = Join-Path $dir.FullName 'bin'
        if ((Test-Path (Join-Path $bin 'mariadb.exe')) -and (Test-Path (Join-Path $bin 'mariadb-dump.exe'))) { return $bin }
    }
    $client = Get-Command mariadb.exe -ErrorAction SilentlyContinue
    $dump = Get-Command mariadb-dump.exe -ErrorAction SilentlyContinue
    if ($client -and $dump) { return Split-Path -Parent $client.Source }
    throw 'MariaDB nao encontrado. Instale o MariaDB nativo para Windows ou adicione o bin ao PATH.'
}

function Invoke-MariaDb {
    param(
        [Parameter(Mandatory=$true)][string]$Exe,
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $oldPwd = $env:MYSQL_PWD
    $oldEap = $ErrorActionPreference
    $stderrFile = Join-Path $env:TEMP ('bacbo_mariadb_stderr_' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $env:MYSQL_PWD = $Password
        $ErrorActionPreference = 'Continue'
        $output = & $Exe @Arguments 2> $stderrFile
        $code = $LASTEXITCODE
        $ErrorActionPreference = $oldEap
        $stderr = @()
        if (Test-Path -LiteralPath $stderrFile) { $stderr = @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) }
        if ($code -ne 0) {
            $details = @($output) + @($stderr)
            throw "MariaDB retornou exit code $code.`n$($details -join [Environment]::NewLine)"
        }
        return $output
    }
    finally {
        $ErrorActionPreference = $oldEap
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
        if ($null -eq $oldPwd) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue } else { $env:MYSQL_PWD = $oldPwd }
    }
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $ProjectRoot 'backups\full' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$envFile = Join-Path $ProjectRoot '.env'
$envMap = Read-EnvFile $envFile
foreach ($required in @('DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME')) {
    if (-not $envMap.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$envMap[$required])) { throw "Configuracao obrigatoria ausente no .env: $required" }
}
if ([string]$envMap['DB_HOST'] -notin @('127.0.0.1','localhost','::1')) { throw "Backup completo foi projetado para o MariaDB local. DB_HOST atual: $($envMap['DB_HOST'])" }

$mariaBin = Find-MariaDbBin
$mariaExe = Join-Path $mariaBin 'mariadb.exe'
$dumpExe = Join-Path $mariaBin 'mariadb-dump.exe'
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupName = "Bacbo_Backup_$timestamp"
$staging = Join-Path $env:TEMP ($backupName + '_' + [guid]::NewGuid().ToString('N'))
$databaseDir = Join-Path $staging 'database'
$projectDir = Join-Path $staging 'project'
$configDir = Join-Path $staging 'config'
$manifestDir = Join-Path $staging 'manifest'
New-Item -ItemType Directory -Path $databaseDir,$projectDir,$configDir,$manifestDir -Force | Out-Null

try {
    Write-Step 'Validando MariaDB local'
    $dbHost = [string]$envMap['DB_HOST']
    $dbPort = [string]$envMap['DB_PORT']
    $dbUser = [string]$envMap['DB_USER']
    $dbPass = [string]$envMap['DB_PASSWORD']
    $dbName = [string]$envMap['DB_NAME']
    $baseArgs = @("--host=$dbHost","--port=$dbPort","--user=$dbUser",'--batch','--skip-column-names')
    $version = (Invoke-MariaDb -Exe $mariaExe -Password $dbPass -Arguments ($baseArgs + @('-e','SELECT VERSION();')) | Select-Object -First 1).ToString().Trim()
    $tableCount = (Invoke-MariaDb -Exe $mariaExe -Password $dbPass -Arguments ($baseArgs + @('-e',"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$dbName' AND table_type='BASE TABLE';")) | Select-Object -First 1).ToString().Trim()
    Write-Host "MariaDB: $version"
    Write-Host "Database: $dbName | tabelas=$tableCount"

    Write-Step 'Gerando dump consistente do banco'
    $dumpFile = Join-Path $databaseDir 'bacbo.sql'
    $oldPwd = $env:MYSQL_PWD
    $oldEap = $ErrorActionPreference
    $dumpErr = Join-Path $env:TEMP ('bacbo_dump_stderr_' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $env:MYSQL_PWD = $dbPass
        $ErrorActionPreference = 'Continue'
        & $dumpExe "--host=$dbHost" "--port=$dbPort" "--user=$dbUser" '--single-transaction' '--quick' '--triggers' '--routines' '--events' '--hex-blob' '--no-tablespaces' '--default-character-set=utf8mb4' $dbName "--result-file=$dumpFile" 2> $dumpErr
        $dumpExit = $LASTEXITCODE
        $ErrorActionPreference = $oldEap
        $dumpStderr = @()
        if (Test-Path -LiteralPath $dumpErr) { $dumpStderr = @(Get-Content -LiteralPath $dumpErr -ErrorAction SilentlyContinue) }
        if ($dumpExit -ne 0) { throw "mariadb-dump falhou com exit code $dumpExit.`n$($dumpStderr -join [Environment]::NewLine)" }
    }
    finally {
        $ErrorActionPreference = $oldEap
        Remove-Item -LiteralPath $dumpErr -Force -ErrorAction SilentlyContinue
        if ($null -eq $oldPwd) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue } else { $env:MYSQL_PWD = $oldPwd }
    }
    if (-not (Test-Path -LiteralPath $dumpFile)) { throw 'Dump nao foi criado.' }
    $dumpInfo = Get-Item -LiteralPath $dumpFile
    if ($dumpInfo.Length -le 0) { throw 'Dump foi criado vazio.' }
    $dumpHash = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash
    Write-Host "Dump OK: $($dumpInfo.Length) bytes | SHA256=$dumpHash"

    Write-Step 'Copiando projeto'
    $excludedDirs = @('.git','backups','migration-db','logs','__pycache__','.pytest_cache')
    if (-not $IncludeDependencies) { $excludedDirs += @('node_modules','venv','.venv') }
    $roboArgs = @($ProjectRoot,$projectDir,'/E','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XF','.env','*.pyc')
    if ($excludedDirs.Count -gt 0) { $roboArgs += '/XD'; $roboArgs += $excludedDirs }
    & robocopy @roboArgs | Out-Null
    $roboCode = $LASTEXITCODE
    if ($roboCode -gt 7) { throw "Falha ao copiar projeto. robocopy exit code=$roboCode" }
    Copy-Item -LiteralPath $envFile -Destination (Join-Path $configDir '.env') -Force
    $restoreScript = Join-Path $ProjectRoot '02_RESTAURAR_SISTEMA.ps1'
    if (Test-Path -LiteralPath $restoreScript -PathType Leaf) { Copy-Item -LiteralPath $restoreScript -Destination (Join-Path $staging '02_RESTAURAR_SISTEMA.ps1') -Force }

    Write-Step 'Gerando manifestos'
    $gitCommit = $null; $gitBranch = $null
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        Push-Location $ProjectRoot
        try { $gitCommit = (& git rev-parse HEAD 2>$null).Trim(); $gitBranch = (& git branch --show-current 2>$null).Trim() } catch {} finally { Pop-Location }
    }
    $nodeVersion = if (Get-Command node.exe -ErrorAction SilentlyContinue) { (& node --version).Trim() } else { $null }
    $npmVersion = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { (& npm --version).Trim() } else { $null }
    $pythonVersion = if (Get-Command python.exe -ErrorAction SilentlyContinue) { (& python --version 2>&1).ToString().Trim() } else { $null }
    $manifest = [ordered]@{
        schema_version = 1
        created_at = (Get-Date).ToString('o')
        computer_name = $env:COMPUTERNAME
        project_root = $ProjectRoot
        database = [ordered]@{ host=$dbHost; port=[int]$dbPort; name=$dbName; user=$dbUser; mariadb_version=$version; table_count=[int]$tableCount; dump_file='database/bacbo.sql'; dump_size_bytes=$dumpInfo.Length; dump_sha256=$dumpHash }
        project = [ordered]@{ git_commit=$gitCommit; git_branch=$gitBranch; dependencies_included=[bool]$IncludeDependencies }
        runtime = [ordered]@{ powershell=$PSVersionTable.PSVersion.ToString(); node=$nodeVersion; npm=$npmVersion; python=$pythonVersion }
        restore = [ordered]@{ script='02_RESTAURAR_SISTEMA.ps1'; default_target='D:\Projetos\Bacbo' }
    }
    $manifestPath = Join-Path $manifestDir 'backup-info.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    $hashEntries = @(
        Get-ChildItem -LiteralPath $staging -File -Recurse |
            Where-Object { $_.FullName -ne (Join-Path $manifestDir 'files.sha256.json') } |
            ForEach-Object { [pscustomobject]@{ file=$_.FullName.Substring($staging.Length + 1).Replace('\','/'); size=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
    )
    if ($hashEntries.Count -eq 0) { throw 'Manifesto de arquivos nao possui entradas.' }
    $hashListPath = Join-Path $manifestDir 'files.sha256.json'
    ConvertTo-Json -InputObject $hashEntries -Depth 3 | Set-Content -LiteralPath $hashListPath -Encoding UTF8

    # Windows PowerShell 5.1 pode devolver o array JSON inteiro como um unico objeto de pipeline.
    # O foreach da linguagem enumera o array corretamente; portanto achatamos explicitamente.
    $parsedHashJson = Get-Content -LiteralPath $hashListPath -Raw | ConvertFrom-Json
    $hashValidation = @()
    foreach ($item in $parsedHashJson) { $hashValidation += $item }
    if ($hashValidation.Count -ne $hashEntries.Count) { throw "Manifesto de hashes invalido. esperado=$($hashEntries.Count) lido=$($hashValidation.Count)" }
    foreach ($entry in $hashValidation) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.file) -or [string]::IsNullOrWhiteSpace([string]$entry.sha256)) { throw 'Manifesto de hashes contem entrada invalida.' }
    }
    Write-Host "Manifesto de hashes OK: $($hashEntries.Count) arquivo(s)."

    Write-Step 'Compactando backup'
    $zipPath = Join-Path $OutputDirectory ($backupName + '.zip')
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $zipPath)) { throw 'ZIP final nao foi criado.' }
    $zipInfo = Get-Item -LiteralPath $zipPath
    if ($zipInfo.Length -le 0) { throw 'ZIP final esta vazio.' }
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    $zipHash | Set-Content -LiteralPath ($zipPath + '.sha256') -Encoding ASCII
    Write-Host ''
    Write-Host 'BACKUP_COMPLETO_OK=true' -ForegroundColor Green
    Write-Host "ZIP=$zipPath"
    Write-Host "ZIP_BYTES=$($zipInfo.Length)"
    Write-Host "ZIP_SHA256=$zipHash"
    Write-Host 'ATENCAO: o ZIP contem o .env e portanto contem credenciais. Guarde-o em local seguro.' -ForegroundColor Yellow
}
catch {
    Write-Host ''
    Write-Host 'BACKUP_COMPLETO_OK=false' -ForegroundColor Red
    throw
}
finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
