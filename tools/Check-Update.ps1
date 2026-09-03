. (Join-Path $PSScriptRoot 'Common.ps1')

$info = Get-BacboInstallInfo
$profile = [string]$info.profile
$root = [string]$info.root

Write-Section 'BAC BO | VERIFICAR ATUALIZACAO'

if ($profile -ne 'SINCRONIZADA_PRODUCAO') {
    Write-Host 'Perfil ISOLADO: atualizacao GitHub nao se aplica.'
    exit 0
}

$intRoot = Join-Path $root 'INT'

$localLines = @(git -C $intRoot rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $localLines.Count -ne 1) {
    throw 'FALHA_AO_LER_HEAD_LOCAL'
}
$local = ([string]$localLines[0]).Trim()

$remoteLines = @(git -C $intRoot ls-remote origin refs/heads/main)
if ($LASTEXITCODE -ne 0 -or $remoteLines.Count -eq 0) {
    throw 'FALHA_AO_CONSULTAR_ORIGIN_MAIN'
}
$remote = (([string]$remoteLines[0]).Trim() -split '\s+')[0]

Write-Host ('Instalado : ' + $local)
Write-Host ('GitHub    : ' + $remote)
Write-Host ''

if ($local -eq $remote) {
    Write-Host 'STATUS: ATUALIZADO' -ForegroundColor Green
} else {
    Write-Host 'STATUS: NOVA VERSAO DISPONIVEL' -ForegroundColor Yellow
    Write-Host 'v0.2 apenas verifica; atualizacao automatica ainda nao executa alteracoes.'
}
