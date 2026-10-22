#!/usr/bin/env pwsh
# SE Assist Startup Script
#
# Sign-in is built into the app (Settings -> Authentication -> "Sign in with Microsoft",
# and Settings -> AI Model -> "Connect GitHub Copilot"). You normally DO NOT need this
# script — just launch the app (`cd desktop; npm start`) or the packaged SE Assist
# executable and sign in from the UI. This script is a thin convenience launcher.
#
# There is no Azure CLI (`az login`) auth path: the in-app Microsoft (Entra ID / MSAL)
# sign-in is the only way to connect MSX, so no CLI install and no .env are required.

Write-Host "`n=== SE Assist Startup ===" -ForegroundColor Cyan
Write-Host "`nSign-in is handled inside the app:" -ForegroundColor Green
Write-Host "  - Microsoft (MSX): Settings -> Authentication -> Sign in with Microsoft" -ForegroundColor DarkGray
Write-Host "  - AI models:       Settings -> AI Model -> Connect GitHub Copilot" -ForegroundColor DarkGray

# Launch Electron app
Write-Host "`nStarting SE Assist..." -ForegroundColor Cyan
Set-Location "$PSScriptRoot\desktop"
npx electron .

