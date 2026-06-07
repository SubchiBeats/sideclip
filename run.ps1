$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }

if (-not $nodePath) {
    $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path $bundledNode) {
        $nodePath = $bundledNode
    }
}

if (-not $nodePath) {
    Write-Host "Node.js 20 or newer is required. Download it from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "SideClip is running at http://localhost:4173" -ForegroundColor Green
Start-Process "http://localhost:4173"
& $nodePath server.js
