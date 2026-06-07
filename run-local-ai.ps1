$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ollama = Get-Command ollama -ErrorAction SilentlyContinue

if (-not $ollama) {
    Write-Host "Ollama is not installed. Download it free from https://ollama.com/download" -ForegroundColor Yellow
    Write-Host "Then run: ollama pull llama3.2:3b" -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}

$env:OLLAMA_MODEL = "llama3.2:3b"
& (Join-Path $root "run.ps1")
