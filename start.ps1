# LM Studio Monitor Dashboard Launcher

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   LM Studio Monitor Dashboard" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) { throw "Not found" }
    Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Check LM Studio
try {
    $response = Invoke-WebRequest -Uri "http://localhost:1234/v1/models" -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) {
        Write-Host "[OK] LM Studio detected on port 1234" -ForegroundColor Green
    }
} catch {
    Write-Host "[WARNING] LM Studio not detected on port 1234" -ForegroundColor Yellow
    Write-Host "         Make sure LM Studio is running" -ForegroundColor Yellow
}

# Install dependencies
Write-Host ""
Write-Host "[1/4] Installing dependencies..." -ForegroundColor Cyan
Set-Location "$PSScriptRoot\proxy"
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] npm install failed" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[OK] Dependencies installed" -ForegroundColor Green

# Start proxy
Write-Host ""
Write-Host "[2/4] Starting proxy service on port 7890..." -ForegroundColor Cyan
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "$PSScriptRoot\proxy" -WindowStyle Normal
Start-Sleep -Seconds 2

# Open dashboard
Write-Host "[3/4] Opening dashboard..." -ForegroundColor Cyan
Start-Process -FilePath "dashboard.html"
Start-Sleep -Milliseconds 500

# Check proxy
Write-Host "[4/4] Checking proxy..." -ForegroundColor Cyan
try {
    $proxyCheck = Invoke-WebRequest -Uri "http://localhost:7890/api/stats" -UseBasicParsing -TimeoutSec 5
    if ($proxyCheck.StatusCode -eq 200) {
        Write-Host "[OK] Proxy is running" -ForegroundColor Green
    }
} catch {
    Write-Host "[WARNING] Proxy may not be running correctly" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Started Successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Proxy:     http://localhost:7890" -ForegroundColor White
Write-Host "  Dashboard: dashboard.html" -ForegroundColor White
Write-Host ""
Write-Host "  Set your API Base URL to:" -ForegroundColor Yellow
Write-Host "  http://localhost:7890/v1" -ForegroundColor White
Write-Host ""

# Keep window open briefly
Start-Sleep -Seconds 1
