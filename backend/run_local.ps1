param(
    [switch]$SkipAnisette
)

$ErrorActionPreference = "Stop"
$backendDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryDirectory = Split-Path -Parent $backendDirectory
Set-Location -LiteralPath $backendDirectory

if (-not (Test-Path -LiteralPath ".env")) {
    throw "backend/.env is required. Copy .env.example and install real secrets first."
}

$databaseSetting = Get-Content -LiteralPath ".env" |
    Where-Object { $_ -match "^\s*DATABASE_URL\s*=" } |
    Select-Object -Last 1
if ($databaseSetting -match "@(?:127\.0\.0\.1|localhost):54322/") {
    if (-not (Get-NetTCPConnection -LocalPort 54322 -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host "Starting the local Supabase stack..."
        Push-Location -LiteralPath $repositoryDirectory
        try {
            npx --yes supabase@2.115.0 start
            if ($LASTEXITCODE -ne 0) {
                throw "The local Supabase stack could not be started."
            }
        } finally {
            Pop-Location
        }
    }
    # The CLI-managed local project uses its documented development credential.
    $env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
}

if (-not $SkipAnisette) {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop must be running before the Anisette container can start."
    }

    $anisetteContainer = docker ps -aq --filter "name=^/anisette-v3$"
    if (-not $anisetteContainer) {
        docker run -d --restart always --name anisette-v3 `
            -p 6969:6969 `
            --volume anisette-v3_data:/home/Alcoholic/.config/anisette-v3/lib/ `
            dadoum/anisette-v3-server | Out-Null
    } elseif (-not (docker ps -q --filter "name=^/anisette-v3$")) {
        docker start anisette-v3 | Out-Null
    }

    $anisetteReady = $false
    foreach ($attempt in 1..10) {
        try {
            $headers = Invoke-RestMethod -Uri "http://127.0.0.1:6969" -TimeoutSec 5
            if ($headers.'X-Apple-I-MD' -and $headers.'X-Apple-I-MD-M') {
                $anisetteReady = $true
                break
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $anisetteReady) {
        throw "The Anisette service did not become ready on http://127.0.0.1:6969."
    }
    Write-Host "Anisette is ready on http://127.0.0.1:6969"
}

& ..\.venv\Scripts\python.exe -m app.server
exit $LASTEXITCODE
