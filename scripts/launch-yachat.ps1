$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {
  # Older PowerShell hosts can ignore UTF-8 console setup.
}

$Root = Split-Path -Parent $PSScriptRoot
$InfoPath = Join-Path $Root "USERS\server\web-server.json"
$DefaultUrl = "http://127.0.0.1:3087"

function Resolve-Electron {
  $candidates = @()

  if ($env:ELECTRON_PATH) {
    $candidates += $env:ELECTRON_PATH
  }

  $command = Get-Command electron -ErrorAction SilentlyContinue
  if ($command) {
    $candidates += $command.Source
  }

  $candidates += @(
    (Join-Path $Root "node_modules\electron\dist\electron.exe"),
    (Join-Path $Root "..\ElJour\node_modules\electron\dist\electron.exe"),
    (Join-Path $Root "..\SuperChat\CONFIG\node_modules\electron\dist\electron.exe"),
    (Join-Path $Root "node_modules\.bin\electron.cmd"),
    (Join-Path $Root "..\ElJour\node_modules\.bin\electron.cmd"),
    (Join-Path $Root "..\SuperChat\CONFIG\node_modules\.bin\electron.cmd")
  )

  $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
}

function Get-StatusFromUrl([string]$baseUrl) {
  if (-not $baseUrl) {
    return $null
  }

  try {
    $statusUrl = $baseUrl.TrimEnd("/") + "/api/status"
    Invoke-RestMethod -Uri $statusUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
  } catch {
    $null
  }
}

function Read-ServerInfo {
  if (-not (Test-Path -LiteralPath $InfoPath)) {
    return $null
  }

  try {
    Get-Content -Raw -LiteralPath $InfoPath | ConvertFrom-Json
  } catch {
    $null
  }
}

function New-ServerResult($status, [string]$source) {
  if (-not $status) {
    return $null
  }

  [pscustomobject]@{
    WebUrl = $status.webUrl
    LanUrl = $status.lanUrl
    Source = $source
  }
}

function Get-RunningServer {
  $info = Read-ServerInfo
  if ($info -and $info.webUrl) {
    $status = Get-StatusFromUrl $info.webUrl
    if ($status) {
      return New-ServerResult $status "web-server.json"
    }
  }

  $status = Get-StatusFromUrl $DefaultUrl
  if ($status) {
    return New-ServerResult $status "default-port"
  }

  $null
}

function Start-YachatElectron([string]$electronPath) {
  $extension = [System.IO.Path]::GetExtension($electronPath).ToLowerInvariant()

  if ($extension -eq ".cmd" -or $extension -eq ".bat") {
    $command = "`"$electronPath`" `"$Root`""
    return Start-Process -FilePath $env:ComSpec -ArgumentList @("/d", "/c", $command) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  }

  Start-Process -FilePath $electronPath -ArgumentList @($Root) -WorkingDirectory $Root -PassThru
}

function Wait-ForServer([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)

  do {
    $server = Get-RunningServer
    if ($server) {
      return $server
    }

    Start-Sleep -Milliseconds 700
  } while ((Get-Date) -lt $deadline)

  $null
}

Set-Location -LiteralPath $Root

Write-Host ""
Write-Host "Yachat launcher"
Write-Host "Project: $Root"

$server = Get-RunningServer

if (-not $server) {
  Remove-Item -LiteralPath $InfoPath -Force -ErrorAction SilentlyContinue

  $electron = Resolve-Electron
  if (-not $electron) {
    throw "Electron was not found. Set ELECTRON_PATH or keep Electron in the nearby ElJour/SuperChat project."
  }

  Write-Host "Starting Electron: $electron"
  $process = Start-YachatElectron $electron
  Write-Host "Process id: $($process.Id)"

  $server = Wait-ForServer 35
}

if (-not $server) {
  throw "Yachat server did not answer in time. Check the Electron window and Windows Firewall prompt."
}

Write-Host ""
Write-Host "Yachat is running."
Write-Host "Local browser: $($server.WebUrl)"
Write-Host "Wi-Fi / public LAN link: $($server.LanUrl)"
Write-Host ""
Write-Host "Open the Wi-Fi link from another device on the same network."
Write-Host "If it does not open, allow Node/Electron in Windows Firewall for Private networks."

Start-Process $server.WebUrl
