[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ArquivoBackup,

    [string]$TargetRoot = '',

    [switch]$Force,

    [switch]$TestMode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step([string]$Message) {
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Read-EnvFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Arquivo .env nao encontrado no backup: $Path"
    }

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

    if ($env:ProgramFiles) {
        $candidates += Get-ChildItem -LiteralPath $env:ProgramFiles -Directory -Filter 'MariaDB*' -ErrorAction SilentlyContinue
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += Get-ChildItem -LiteralPath ${env:ProgramFiles(x86)} -Directory -Filter 'MariaDB*' -ErrorAction SilentlyContinue
    }

    foreach ($dir in ($candidates | Sort-Object Name -Descending)) {
        $bin = Join-Path $dir.FullName 'bin'
        if (Test-Path (Join-Path $bin 'mariadb.exe')) { return $bin }
    }

    $client = Get-Command mariadb.exe -ErrorAction SilentlyContinue
    if ($client) { return Split-Path -Parent $client.Source }

    throw 'MariaDB nao encontrado. Instale o MariaDB nativo para Windows antes do restore.'
}

function Invoke-MariaDb {
    param(
        [Parameter(Mandatory=$true)][string]$Exe,
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [string]$InputFile = ''
    )

    $oldPwd = $env:MYSQL_PWD
    $oldErrorActionPreference = $ErrorActionPreference

    try {
        $env:MYSQL_PWD = $Password

        if ([string]::IsNullOrWhiteSpace($InputFile)) {
            $stderrFile = Join-Path $env:TEMP ('bacbo_mariadb_stderr_' + [guid]::NewGuid().ToString('N') + '.txt')
            try {
                $ErrorActionPreference = 'Continue'
                $output = & $Exe @Arguments 2> $stderrFile
                $code = $LASTEXITCODE
                $ErrorActionPreference = $oldErrorActionPreference

                $stderr = @()
                if (Test-Path -LiteralPath $stderrFile) {
                    $stderr = @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue)
                }

                if ($code -ne 0) {
                    $details = @($output) + @($stderr)
                    throw "MariaDB retornou exit code $code.`n$($details -join [Environment]::NewLine)"
                }
            }
            finally {
                $ErrorActionPreference = $oldErrorActionPreference
                Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
            }
        }
        else {
            $stdoutFile = Join-Path $env:TEMP ('bacbo_mariadb_stdout_' + [guid]::NewGuid().ToString('N') + '.txt')
            $stderrFile = Join-Path $env:TEMP ('bacbo_mariadb_stderr_' + [guid]::NewGuid().ToString('N') + '.txt')
            try {
                $process = Start-Process `
                    -FilePath $Exe `
                    -ArgumentList $Arguments `
                    -NoNewWindow `
                    -Wait `
                    -PassThru `
                    -RedirectStandardInput $InputFile `
                    -RedirectStandardOutput $stdoutFile `
                    -RedirectStandardError $stderrFile

                $code = $process.ExitCode
                $output = @()
                if (Test-Path -LiteralPath $stdoutFile) {
                    $output += Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue
                }
                if (Test-Path -LiteralPath $stderrFile) {
                    $stderr = @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue)
                }
                else {
                    $stderr = @()
                }

                if ($code -ne 0) {
                    $details = @($output) + @($stderr)
                    throw "MariaDB retornou exit code $code.`n$($details -join [Environment]::NewLine)"
                }
            }
            finally {
                Remove-Item -LiteralPath $stdoutFile,$stderrFile -Force -ErrorAction SilentlyContinue
            }
        }

        return $output
    }
    finally {
        $ErrorActionPreference = $oldErrorActionPreference
        if ($null -eq $oldPwd) {
            Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        }
        else {
            $env:MYSQL_PWD = $oldPwd
        }
    }
}

function Convert-SecureStringToPlainText([System.Security.SecureString]$Secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Escape-SqlLiteral([string]$Value) {
    return $Value.Replace('\','\\').Replace("'","''")
}

$backupPath = (Resolve-Path -LiteralPath $ArquivoBackup).Path
if ([IO.Path]::GetExtension($backupPath).ToLowerInvariant() -ne '.zip') {
    throw 'O arquivo de backup deve ser um .zip gerado por 01_BACKUP_COMPLETO.ps1.'
}

$mariaBin = Find-MariaDbBin
$mariaExe = Join-Path $mariaBin 'mariadb.exe'
$staging = Join-Path $env:TEMP ('Bacbo_Restore_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$rootPassword = $null
$testDbName = $null
$testAppUser = $null
$testTargetRoot = $null
$dbPortForCleanup = '3306'

try {
    Write-Step 'Extraindo backup'
    Expand-Archive -LiteralPath $backupPath -DestinationPath $staging -Force

    $manifestPath = Join-Path $staging 'manifest\backup-info.json'
    $hashListPath = Join-Path $staging 'manifest\files.sha256.json'
    $dumpFile = Join-Path $staging 'database\bacbo.sql'
    $projectSource = Join-Path $staging 'project'
    $envSource = Join-Path $staging 'config\.env'

    foreach ($requiredPath in @($manifestPath,$dumpFile,$projectSource,$envSource)) {
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw "Backup invalido ou incompleto. Ausente: $requiredPath"
        }
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([int]$manifest.schema_version -ne 1) {
        throw "Versao de manifesto nao suportada: $($manifest.schema_version)"
    }

    Write-Host "Backup criado em: $($manifest.created_at)"
    Write-Host "Commit: $($manifest.project.git_commit)"
    Write-Host "MariaDB de origem: $($manifest.database.mariadb_version)"
    Write-Host "Tabelas esperadas: $($manifest.database.table_count)"

    Write-Step 'Validando integridade do backup'

    $actualDumpHash = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash
    if ($actualDumpHash -ne [string]$manifest.database.dump_sha256) {
        throw 'SHA256 do dump diverge do manifesto. Restore abortado.'
    }

    if (Test-Path -LiteralPath $hashListPath) {
        $hashEntries = @(Get-Content -LiteralPath $hashListPath -Raw | ConvertFrom-Json)
        foreach ($entry in $hashEntries) {
            $relative = ([string]$entry.file).Replace('/', '\')
            $candidate = Join-Path $staging $relative
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "Arquivo listado no manifesto esta ausente: $relative"
            }
            $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
            if ($actual -ne [string]$entry.sha256) {
                throw "Falha de integridade em: $relative"
            }
        }
    }

    Write-Host 'BACKUP_INTEGRITY_OK=true' -ForegroundColor Green

    Write-Step 'Validando configuracao restaurada'

    $envMap = Read-EnvFile $envSource
    foreach ($required in @('DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME')) {
        if (-not $envMap.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$envMap[$required])) {
            throw "Configuracao obrigatoria ausente no .env do backup: $required"
        }
    }

    $dbName = [string]$envMap['DB_NAME']
    $appUser = [string]$envMap['DB_USER']
    $appPassword = [string]$envMap['DB_PASSWORD']
    $dbPort = [string]$envMap['DB_PORT']
    $dbPortForCleanup = $dbPort

    if ([string]$envMap['DB_HOST'] -notin @('127.0.0.1','localhost','::1')) {
        throw "O backup nao aponta para banco local. DB_HOST=$($envMap['DB_HOST'])"
    }

    if ($dbName -notmatch '^[A-Za-z0-9_]+$') { throw "DB_NAME invalido no backup: $dbName" }
    if ($appUser -notmatch '^[A-Za-z0-9_]+$') { throw "DB_USER invalido no backup: $appUser" }

    if ($TestMode) {
        $testId = [guid]::NewGuid().ToString('N').Substring(0,8)
        $testDbName = "bacbo_restore_test_$testId"
        $testAppUser = "bacbo_rt_$testId"
        $testTargetRoot = Join-Path $env:TEMP "Bacbo_Restore_Test_$testId"

        $dbName = $testDbName
        $appUser = $testAppUser
        $TargetRoot = $testTargetRoot
        $Force = $true

        Write-Host 'RESTORE_TEST_MODE=true' -ForegroundColor Yellow
        Write-Host "Banco temporario: $dbName"
        Write-Host "Usuario temporario: $appUser"
        Write-Host "Pasta temporaria: $TargetRoot"
    }
    else {
        $defaultTargetRoot = 'D:\Projetos\Bacbo'
        if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
            $typedTarget = Read-Host "Pasta de instalacao [$defaultTargetRoot]"
            if ([string]::IsNullOrWhiteSpace($typedTarget)) {
                $TargetRoot = $defaultTargetRoot
            }
            else {
                $TargetRoot = $typedTarget.Trim().Trim('"')
            }
        }
    }

    $TargetRoot = [IO.Path]::GetFullPath($TargetRoot)
    Write-Host "Destino selecionado: $TargetRoot"

    Write-Step 'Preparando destino da aplicacao'

    if (Test-Path -LiteralPath $TargetRoot) {
        $existing = @(Get-ChildItem -LiteralPath $TargetRoot -Force -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0 -and -not $Force) {
            throw "O destino ja contem arquivos: $TargetRoot. Use -Force somente se deseja restaurar por cima do destino existente."
        }
    }
    else {
        New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
    }

    Write-Step 'Restaurando arquivos do projeto'

    & robocopy $projectSource $TargetRoot /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    $roboCode = $LASTEXITCODE
    if ($roboCode -gt 7) { throw "Falha no restore dos arquivos. robocopy exit code=$roboCode" }

    $targetEnv = Join-Path $TargetRoot '.env'
    Copy-Item -LiteralPath $envSource -Destination $targetEnv -Force

    if ($TestMode) {
        $targetEnvContent = Get-Content -LiteralPath $targetEnv
        $targetEnvContent = $targetEnvContent | ForEach-Object {
            if ($_ -match '^\s*DB_NAME\s*=') { "DB_NAME=$dbName" }
            elseif ($_ -match '^\s*DB_USER\s*=') { "DB_USER=$appUser" }
            else { $_ }
        }
        $targetEnvContent | Set-Content -LiteralPath $targetEnv -Encoding UTF8
    }

    Write-Step 'Recriando banco e usuario MariaDB'

    $rootSecure = Read-Host 'Senha do root do MariaDB local' -AsSecureString
    $rootPassword = Convert-SecureStringToPlainText $rootSecure

    $escapedAppPassword = Escape-SqlLiteral $appPassword
    $adminSql = @"
DROP DATABASE IF EXISTS ``$dbName``;
CREATE DATABASE ``$dbName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$appUser'@'127.0.0.1' IDENTIFIED BY '$escapedAppPassword';
CREATE USER IF NOT EXISTS '$appUser'@'localhost' IDENTIFIED BY '$escapedAppPassword';
ALTER USER '$appUser'@'127.0.0.1' IDENTIFIED BY '$escapedAppPassword';
ALTER USER '$appUser'@'localhost' IDENTIFIED BY '$escapedAppPassword';
GRANT ALL PRIVILEGES ON ``$dbName``.* TO '$appUser'@'127.0.0.1';
GRANT ALL PRIVILEGES ON ``$dbName``.* TO '$appUser'@'localhost';
FLUSH PRIVILEGES;
"@

    $adminSqlFile = Join-Path $staging 'restore-admin.sql'
    $adminSql | Set-Content -LiteralPath $adminSqlFile -Encoding UTF8

    Invoke-MariaDb -Exe $mariaExe -Password $rootPassword -Arguments @(
        '--host=127.0.0.1',
        "--port=$dbPort",
        '--user=root'
    ) -InputFile $adminSqlFile | Out-Null

    Write-Step 'Importando banco de dados'

    Invoke-MariaDb -Exe $mariaExe -Password $rootPassword -Arguments @(
        '--host=127.0.0.1',
        "--port=$dbPort",
        '--user=root',
        $dbName
    ) -InputFile $dumpFile | Out-Null

    Remove-Item -LiteralPath $adminSqlFile -Force -ErrorAction SilentlyContinue

    Write-Step 'Validando banco restaurado com usuario da aplicacao'

    $validation = Invoke-MariaDb -Exe $mariaExe -Password $appPassword -Arguments @(
        '--host=127.0.0.1',
        "--port=$dbPort",
        "--user=$appUser",
        '--batch',
        '--skip-column-names',
        $dbName,
        '-e',
        "SELECT CONCAT(DATABASE(),'|',COUNT(*)) FROM information_schema.tables WHERE table_schema='$dbName' AND table_type='BASE TABLE';"
    )

    $validationLine = ($validation | Select-Object -First 1).ToString().Trim()
    $parts = $validationLine -split '\|', 2
    if ($parts.Count -ne 2) { throw "Resposta inesperada na validacao: $validationLine" }

    $restoredDb = $parts[0]
    $restoredTables = [int]$parts[1]
    $expectedTables = [int]$manifest.database.table_count

    if ($restoredDb -ne $dbName -or $restoredTables -ne $expectedTables) {
        throw "Validacao final falhou. banco=$restoredDb tabelas=$restoredTables esperado=$expectedTables"
    }

    Write-Host "Banco=$restoredDb | tabelas=$restoredTables"

    Write-Step 'Validando runtimes da aplicacao'

    $nodeOk = [bool](Get-Command node.exe -ErrorAction SilentlyContinue)
    $npmOk = [bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)
    $pythonOk = [bool](Get-Command python.exe -ErrorAction SilentlyContinue)

    Write-Host "NODE_INSTALLED=$nodeOk"
    Write-Host "NPM_INSTALLED=$npmOk"
    Write-Host "PYTHON_INSTALLED=$pythonOk"

    if (-not $nodeOk -or -not $npmOk -or -not $pythonOk) {
        Write-Warning 'Banco e projeto foram restaurados, mas algum runtime nao esta instalado. Consulte manifest\backup-info.json para as versoes usadas no backup.'
    }

    Write-Host ''
    if ($TestMode) {
        Write-Host 'RESTAURACAO_TESTE_OK=true' -ForegroundColor Green
        Write-Host "TEST_DATABASE=$dbName"
        Write-Host "TEST_TABLES=$restoredTables"
        Write-Host 'O banco e a pasta temporarios serao removidos automaticamente.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'RESTAURACAO_COMPLETA_OK=true' -ForegroundColor Green
        Write-Host "PROJECT_ROOT=$TargetRoot"
        Write-Host "DATABASE=$dbName"
        Write-Host "TABLES=$restoredTables"
        Write-Host 'O sistema nao foi iniciado automaticamente. Inicie pelo mesmo CMD/atalho operacional usado normalmente.' -ForegroundColor Yellow
    }
}
catch {
    Write-Host ''
    if ($TestMode) {
        Write-Host 'RESTAURACAO_TESTE_OK=false' -ForegroundColor Red
    }
    else {
        Write-Host 'RESTAURACAO_COMPLETA_OK=false' -ForegroundColor Red
    }
    throw
}
finally {
    if ($TestMode -and -not [string]::IsNullOrWhiteSpace([string]$rootPassword) -and -not [string]::IsNullOrWhiteSpace([string]$testDbName)) {
        try {
            $cleanupSql = @"
DROP DATABASE IF EXISTS ``$testDbName``;
DROP USER IF EXISTS '$testAppUser'@'127.0.0.1';
DROP USER IF EXISTS '$testAppUser'@'localhost';
FLUSH PRIVILEGES;
"@
            $cleanupSqlFile = Join-Path $staging 'restore-test-cleanup.sql'
            $cleanupSql | Set-Content -LiteralPath $cleanupSqlFile -Encoding UTF8
            Invoke-MariaDb -Exe $mariaExe -Password $rootPassword -Arguments @(
                '--host=127.0.0.1',
                "--port=$dbPortForCleanup",
                '--user=root'
            ) -InputFile $cleanupSqlFile | Out-Null
            Write-Host 'RESTORE_TEST_DATABASE_CLEANUP=true' -ForegroundColor Green
        }
        catch {
            Write-Warning "Nao foi possivel limpar automaticamente o banco/usuario temporario: $($_.Exception.Message)"
        }
    }

    $rootPassword = $null

    if ($TestMode -and -not [string]::IsNullOrWhiteSpace([string]$testTargetRoot) -and (Test-Path -LiteralPath $testTargetRoot)) {
        Remove-Item -LiteralPath $testTargetRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
