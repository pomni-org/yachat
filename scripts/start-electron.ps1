$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Candidates = @()

if ($env:ELECTRON_PATH) {
  $Candidates += $env:ELECTRON_PATH
}

$Command = Get-Command electron -ErrorAction SilentlyContinue
if ($Command) {
  $Candidates += $Command.Source
}

$Candidates += @(
  (Join-Path $Root "node_modules\.bin\electron.cmd"),
  (Join-Path $Root "..\3. ЭлЖур\node_modules\.bin\electron.cmd"),
  (Join-Path $Root "..\ElJour\node_modules\.bin\electron.cmd"),
  (Join-Path $Root "..\SuperChat\CONFIG\node_modules\.bin\electron.cmd"),
  (Join-Path $Root "..\3. ЭлЖур\node_modules\electron\dist\electron.exe"),
  (Join-Path $Root "..\ElJour\node_modules\electron\dist\electron.exe"),
  (Join-Path $Root "..\SuperChat\CONFIG\node_modules\electron\dist\electron.exe")
)

$Parent = Split-Path -Parent $Root
if (Test-Path -LiteralPath $Parent) {
  Get-ChildItem -LiteralPath $Parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $Candidates += Join-Path $_.FullName "node_modules\.bin\electron.cmd"
    $Candidates += Join-Path $_.FullName "node_modules\electron\dist\electron.exe"
    $Candidates += Join-Path $_.FullName "CONFIG\node_modules\.bin\electron.cmd"
    $Candidates += Join-Path $_.FullName "CONFIG\node_modules\electron\dist\electron.exe"
  }
}

$Electron = $Candidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if (-not $Electron) {
  Write-Error "Electron не найден. Поставь ELECTRON_PATH или положи Electron в соседний проект ElJour/SuperChat."
}

Write-Host "Starting ЯЧат with Electron: $Electron"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& $Electron $Root
