<#
    AI Auto Editor Pro — Windows setup and launcher.

    Called by the installed shortcuts. Everything the platform needs beyond
    Windows itself is checked here and fetched with a visible progress bar if it
    is missing.

    Usage:
      Setup.ps1                 install what is missing, then start
      Setup.ps1 -Action Start   start (installing anything missing first)
      Setup.ps1 -Action Stop    stop, keeping all data
      Setup.ps1 -Action Doctor  diagnose why it will not start
#>
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Doctor')]
    [string]$Action = 'Start',

    [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'Continue'

# Docker Desktop x64. Pinned to the stable "latest" endpoint Docker publishes.
$DockerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'

# --- Presentation -----------------------------------------------------------

function Write-Head($text) {
    Write-Host ''
    Write-Host "  $text" -ForegroundColor White
    Write-Host ''
}
function Write-Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "  ..     $text" -ForegroundColor Gray }
function Write-Warn($text) { Write-Host "  [!]    $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [X]    $text" -ForegroundColor Red }

function Pause-Exit([int]$code = 0) {
    Write-Host ''
    if ($Host.Name -eq 'ConsoleHost') {
        Write-Host '  Press any key to close...' -ForegroundColor DarkGray
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    }
    exit $code
}

# --- Dependency checks ------------------------------------------------------

function Test-DockerInstalled {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    # Docker Desktop does not always put docker on PATH for the current session.
    return (Test-Path "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe")
}

function Get-DockerExe {
    $cmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Test-DockerRunning {
    $docker = Get-DockerExe
    if (-not $docker) { return $false }
    & $docker info *> $null
    return ($LASTEXITCODE -eq 0)
}

<#
    Download with a real progress bar.

    Invoke-WebRequest hides progress when $ProgressPreference is silent and is
    slow for large files, so this streams the response and reports percentage
    against Content-Length.
#>
function Get-FileWithProgress {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Destination,
        [string]$Activity = 'Downloading'
    )

    $client   = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromHours(2)

    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).
                        GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "$Activity failed: HTTP $([int]$response.StatusCode) $($response.ReasonPhrase)"
        }

        $total  = $response.Content.Headers.ContentLength
        $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $target = [System.IO.File]::Create($Destination)

        try {
            $buffer     = New-Object byte[] 1048576
            $readTotal  = 0L
            $lastReport = -1

            while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $target.Write($buffer, 0, $read)
                $readTotal += $read

                if ($total) {
                    $percent = [int](($readTotal / $total) * 100)
                    if ($percent -ne $lastReport) {
                        $lastReport = $percent
                        $mb    = [math]::Round($readTotal / 1MB, 1)
                        $mbAll = [math]::Round($total / 1MB, 1)
                        Write-Progress -Activity $Activity `
                                       -Status "$mb MB of $mbAll MB" `
                                       -PercentComplete $percent
                    }
                } else {
                    $mb = [math]::Round($readTotal / 1MB, 1)
                    Write-Progress -Activity $Activity -Status "$mb MB"
                }
            }
        } finally {
            $target.Dispose()
            $source.Dispose()
        }

        Write-Progress -Activity $Activity -Completed
    } finally {
        $client.Dispose()
    }
}

function Install-DockerDesktop {
    Write-Warn 'Docker Desktop is not installed. It provides the database, cache and video engine.'
    Write-Info 'Downloading Docker Desktop (about 550 MB)...'

    $installer = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    Get-FileWithProgress -Url $DockerUrl -Destination $installer -Activity 'Downloading Docker Desktop'
    Write-Ok 'Downloaded'

    Write-Info 'Running the Docker Desktop installer. Accept its prompts when they appear.'
    $proc = Start-Process -FilePath $installer -ArgumentList 'install', '--quiet', '--accept-license' `
                          -Wait -PassThru -Verb RunAs

    if ($proc.ExitCode -ne 0) {
        throw "The Docker Desktop installer exited with code $($proc.ExitCode). Install it manually from https://www.docker.com/products/docker-desktop/ and run this again."
    }

    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    Write-Ok 'Docker Desktop installed'
    Write-Warn 'Windows usually needs a restart before Docker will start. If the next step stalls, reboot and run this again.'
}

function Start-DockerEngine {
    $desktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) {
        Write-Info 'Starting Docker Desktop...'
        Start-Process $desktop -ErrorAction SilentlyContinue
    }

    Write-Info 'Waiting for the Docker engine (this can take a couple of minutes on a cold start)...'
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerRunning) {
            Write-Progress -Activity 'Waiting for Docker' -Completed
            Write-Ok 'Docker engine ready'
            return $true
        }
        $left = [int]($deadline - (Get-Date)).TotalSeconds
        Write-Progress -Activity 'Waiting for Docker' -Status "Up to $left seconds remaining"
        Start-Sleep -Seconds 3
    }

    Write-Progress -Activity 'Waiting for Docker' -Completed
    return $false
}

# --- Application configuration ---------------------------------------------

function New-EnvFile {
    $envPath     = Join-Path $InstallRoot '.env'
    $examplePath = Join-Path $InstallRoot '.env.example'

    if (Test-Path $envPath) {
        Write-Ok 'Using the existing settings file'
        return
    }
    if (-not (Test-Path $examplePath)) {
        throw ".env.example is missing from $InstallRoot — the installation looks incomplete."
    }

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

    $jwtBytes = New-Object byte[] 48
    $rng.GetBytes($jwtBytes)
    $jwt = [Convert]::ToBase64String($jwtBytes)

    # Exactly 32 bytes, hex encoded: the API rejects any other length.
    $keyBytes = New-Object byte[] 32
    $rng.GetBytes($keyBytes)
    $key = ([BitConverter]::ToString($keyBytes)).Replace('-', '').ToLower()

    $text = Get-Content $examplePath -Raw
    $text = [regex]::Replace($text, '(?m)^JWT_SECRET=.*$',     'JWT_SECRET=' + $jwt)
    $text = [regex]::Replace($text, '(?m)^ENCRYPTION_KEY=.*$', 'ENCRYPTION_KEY=' + $key)

    # UTF-8 without a BOM: docker compose does not strip one, and it would end
    # up inside the first variable name.
    [System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok 'Created settings with freshly generated secrets'
}

function Get-EnvValue([string]$Key, [string]$Default) {
    $envPath = Join-Path $InstallRoot '.env'
    if (-not (Test-Path $envPath)) { return $Default }

    $line = Select-String -Path $envPath -Pattern "^\s*$Key\s*=" -ErrorAction SilentlyContinue |
            Select-Object -Last 1
    if (-not $line) { return $Default }

    $value = ($line.Line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

function Invoke-Compose {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $docker = Get-DockerExe
    if (-not $docker) { throw 'docker was not found on this system.' }

    Push-Location $InstallRoot
    try {
        & $docker compose @Arguments
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Wait-ForApp([int]$WebPort, [int]$ApiPort) {
    Write-Info 'Waiting for the platform to answer...'
    $deadline = (Get-Date).AddMinutes(5)

    while ((Get-Date) -lt $deadline) {
        $apiUp = $false
        $webUp = $false
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$ApiPort/ready"
            $apiUp = ($r.StatusCode -eq 200)
        } catch { }
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$WebPort"
            $webUp = ($r.StatusCode -eq 200)
        } catch { }

        if ($apiUp -and $webUp) {
            Write-Progress -Activity 'Starting' -Completed
            return $true
        }

        $left = [int]($deadline - (Get-Date)).TotalSeconds
        Write-Progress -Activity 'Starting' -Status "Up to $left seconds remaining"
        Start-Sleep -Seconds 3
    }

    Write-Progress -Activity 'Starting' -Completed
    return $false
}

# --- Actions ----------------------------------------------------------------

function Invoke-Start {
    Write-Head 'AI Auto Editor Pro'

    if (-not (Test-DockerInstalled)) {
        Install-DockerDesktop
    } else {
        Write-Ok 'Docker Desktop is installed'
    }

    if (-not (Test-DockerRunning)) {
        if (-not (Start-DockerEngine)) {
            Write-Bad 'Docker did not become ready within five minutes.'
            Write-Host ''
            Write-Host '  If Docker Desktop was only just installed, restart Windows and try again.' -ForegroundColor Gray
            Write-Host '  Otherwise open Docker Desktop and wait for the whale icon to settle.' -ForegroundColor Gray
            Pause-Exit 1
        }
    } else {
        Write-Ok 'Docker engine ready'
    }

    New-EnvFile

    $webPort = [int](Get-EnvValue 'WEB_PORT' '3000')
    $apiPort = [int](Get-EnvValue 'API_PORT' '4000')

    Write-Host ''
    Write-Info 'Building and starting. The first run compiles everything — expect 5 to 10 minutes.'
    Write-Info 'Later starts take a few seconds.'
    Write-Host ''

    $code = Invoke-Compose @('up', '-d', '--build')
    if ($code -ne 0) {
        Write-Bad "Startup failed (exit code $code)."
        Write-Host ''
        Write-Host '  See what went wrong with:' -ForegroundColor Gray
        Write-Host "    docker compose logs --tail=80" -ForegroundColor White
        Pause-Exit 1
    }

    if (-not (Wait-ForApp -WebPort $webPort -ApiPort $apiPort)) {
        Write-Bad 'It started but never answered.'
        Write-Host "    docker compose logs --tail=80" -ForegroundColor White
        Pause-Exit 1
    }

    Write-Ok "API   http://localhost:$apiPort"
    Write-Ok "App   http://localhost:$webPort"

    Start-Process "http://localhost:$webPort"

    Write-Head 'Next steps'
    Write-Host '    1. Create an account — the first one becomes the administrator.' -ForegroundColor Gray
    Write-Host '    2. Open API management and add a Gemini API key.' -ForegroundColor Gray
    Write-Host '       Get one free at https://aistudio.google.com/apikey' -ForegroundColor Gray
    Write-Host '    3. Create a project and upload a voiceover.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Stop it later from the Start menu. Your data is kept.' -ForegroundColor DarkGray
    Pause-Exit 0
}

function Invoke-Stop {
    Write-Head 'Stopping AI Auto Editor Pro'
    if (-not (Test-DockerRunning)) {
        Write-Warn 'Docker is not running — nothing to stop.'
        Pause-Exit 0
    }
    $null = Invoke-Compose @('down')
    Write-Ok 'Stopped. Your projects and media are kept.'
    Pause-Exit 0
}

function Invoke-Doctor {
    Write-Head 'Diagnostics'

    if (-not (Test-DockerInstalled)) {
        Write-Bad 'Docker Desktop is not installed.'
        Write-Host '  Fix: run AI Auto Editor Pro from the Start menu — it installs Docker for you.' -ForegroundColor White
        Pause-Exit 1
    }
    Write-Ok 'Docker Desktop installed'

    if (-not (Test-DockerRunning)) {
        Write-Bad 'Docker Desktop is installed but not running.'
        Write-Host '  Fix: start Docker Desktop and wait for the whale icon to settle.' -ForegroundColor White
        Pause-Exit 1
    }
    Write-Ok 'Docker engine running'

    $webPort = [int](Get-EnvValue 'WEB_PORT' '3000')
    $apiPort = [int](Get-EnvValue 'API_PORT' '4000')
    Write-Ok "Configured ports: web $webPort, API $apiPort"

    Write-Host ''
    $null = Invoke-Compose @('ps')
    Write-Host ''

    foreach ($p in @($webPort, 3000)) {
        try {
            $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$p"
            Write-Ok "http://localhost:$p answers"
            if ($p -ne $webPort) {
                Write-Warn "The app is on $p, not the $webPort you configured."
                Write-Host '  Fix: docker compose down, then start it again from the Start menu.' -ForegroundColor White
            }
            Pause-Exit 0
        } catch {
            Write-Bad "http://localhost:$p refused"
        }
    }

    Write-Host ''
    Write-Host '  Nothing is answering. Start it from the Start menu, or inspect:' -ForegroundColor Gray
    Write-Host '    docker compose logs --tail=80' -ForegroundColor White
    Pause-Exit 1
}

try {
    switch ($Action) {
        'Start'  { Invoke-Start }
        'Stop'   { Invoke-Stop }
        'Doctor' { Invoke-Doctor }
    }
} catch {
    Write-Host ''
    Write-Bad $_.Exception.Message
    Pause-Exit 1
}
