param(
    [switch]$SkipAnisette
)

$ErrorActionPreference = "Stop"
$backendDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryDirectory = Split-Path -Parent $backendDirectory
$pythonExecutable = Join-Path $repositoryDirectory ".venv\Scripts\python.exe"
Set-Location -LiteralPath $backendDirectory

if (-not (Test-Path -LiteralPath ".env")) {
    throw "backend/.env is required. Copy .env.example and install real secrets first."
}
if (-not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
    throw "The repository virtual environment is missing. From the repository root run: python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e .\backend"
}

$anisetteProvider = $env:PINQEVA_FINDMY_ANISETTE_PROVIDER
if ([string]::IsNullOrWhiteSpace($anisetteProvider)) {
    $anisetteProviderSetting = Get-Content -LiteralPath ".env" |
        Where-Object { $_ -match "^\s*PINQEVA_FINDMY_ANISETTE_PROVIDER\s*=" } |
        Select-Object -Last 1
    if ($null -ne $anisetteProviderSetting) {
        $anisetteProvider = (($anisetteProviderSetting -split "=", 2)[1] -split "#", 2)[0].Trim()
        $anisetteProvider = $anisetteProvider.Trim("'").Trim('"')
    } else {
        $anisetteProvider = "http"
    }
}
$anisetteProvider = $anisetteProvider.Trim().ToLowerInvariant()
if ($anisetteProvider -notin @("http", "native")) {
    throw "PINQEVA_FINDMY_ANISETTE_PROVIDER must be http or native."
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

if ($anisetteProvider -eq "native") {
    Write-Host "The embedded native Anisette provider will provision before Uvicorn starts."
} elseif (-not $SkipAnisette) {
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
} else {
    Write-Host "Skipping external Anisette startup; the configured HTTP service must already be ready."
}

& $pythonExecutable -m app.server
exit $LASTEXITCODE
