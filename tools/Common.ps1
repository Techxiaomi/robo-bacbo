$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 62) -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 62) -ForegroundColor Cyan
}

function Get-BacboInstallInfo {
    $path = Join-Path $env:ProgramData 'BACBO\install.json'
    if (-not (Test-Path -LiteralPath $path)) {
        throw "INSTALACAO_NAO_REGISTRADA: $path"
    }
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}

function Test-PortListening([int]$Port) {
    $items = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    return ($items.Count -gt 0)
}

function Get-PortOwner([int]$Port) {
    $items = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) { return $null }
    return [int]$items[0].OwningProcess
}

function Test-RespPing([int]$Port = 6379, [int]$TimeoutMs = 2500) {
    $client = $null
    $stream = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        if (-not $client.Connected) { return $false }

        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $stream.WriteTimeout = $TimeoutMs

        $bytes = [System.Text.Encoding]::ASCII.GetBytes("*1`r`n`$4`r`nPING`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $buffer = New-Object byte[] 64
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { return $false }

        $reply = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        return $reply.StartsWith('+PONG')
    } catch {
        return $false
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
}

function Wait-RespPing([int]$Port = 6379, [int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-RespPing -Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-BackendReady([int]$Port, [int]$TimeoutSeconds = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $code = 0
        try {
            $response = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri ("http://127.0.0.1:{0}/collector-health" -f $Port) `
                -Method GET `
                -TimeoutSec 2 `
                -ErrorAction Stop
            $code = [int]$response.StatusCode
        } catch {
            if ($null -ne $_.Exception.Response) {
                try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
            }
        }

        # Durante bootstrap o middleware retorna 503.
        # Depois do bootstrap, GET em uma rota POST-only chega ao roteamento e responde 404.
        if ($code -eq 404) { return $true }

        Start-Sleep -Seconds 1
    }
    return $false
}
