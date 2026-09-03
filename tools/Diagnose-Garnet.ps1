. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$root = [string]$info.root
$logRoot = Join-Path $root 'logs\garnet'
$supervisorLog = Join-Path $logRoot 'supervisor.log'
$instancesRoot = Join-Path $logRoot 'instances'

Write-Section 'BAC BO | DIAGNOSTICO GARNET'

Write-Host '[1/3] Estado atual'

if (Test-PortListening 6379) {
    Write-Host (
        '6379................... LISTENING | PID={0}' -f
        (Get-PortOwner 6379)
    ) -ForegroundColor Green
}
else {
    Write-Host '6379................... OFF'
}

Write-Host ''
Write-Host '[2/3] Supervisor | ultimas 120 linhas'

if (Test-Path -LiteralPath $supervisorLog) {
    Get-Content `
        -LiteralPath $supervisorLog `
        -Tail 120
}
else {
    Write-Host 'SUPERVISOR_LOG_AUSENTE'
}

Write-Host ''
Write-Host '[3/3] Ultimas instancias Garnet'

$instanceFiles = @(
    Get-ChildItem `
        -LiteralPath $instancesRoot `
        -File `
        -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 8
)

if ($instanceFiles.Count -eq 0) {
    Write-Host 'INSTANCE_LOGS=0'
}
else {
    foreach ($file in $instanceFiles) {
        Write-Host ''
        Write-Host '------------------------------------------------------------'
        Write-Host $file.FullName
        Write-Host '------------------------------------------------------------'

        Get-Content `
            -LiteralPath $file.FullName `
            -Tail 100
    }
}
