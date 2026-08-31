<#
    AI Auto Editor Pro - Windows setup and launcher.

    Called by Start.cmd / Stop.cmd / Diagnose.cmd, which keep the window open
    and capture a log even if this script fails to parse.

    Deliberately ASCII-only and written as UTF-8 with a BOM: Windows PowerShell
    5.1 decodes a BOM-less file as ANSI, which corrupts any non-ASCII character
    and can turn a working script into a parse error that closes the window
    before anything is printed.

    Usage:
      Setup.ps1 -Action Start    start, installing anything missing first
      Setup.ps1 -Action Stop     stop, keeping all data
      Setup.ps1 -Action Doctor   diagnose why it will not start
#>
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Doctor')]
    [string]$Action = 'Start',

    [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'Continue'

# Windows PowerShell 5.1 on older builds still negotiates TLS 1.0 by default,
# which every download endpoint below refuses.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

$DockerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'

# --- Output -----------------------------------------------------------------

function Write-Head($text) {
    Write-Host ''
    Write-Host "  $text" -ForegroundColor White
    Write-Host ''
}
function Write-Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "  ...    $text" -ForegroundColor Gray }
function Write-Warn($text) { Write-Host "  [!]    $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [X]    $text" -ForegroundColor Red }

function Write-Step($number, $total, $text) {
    Write-Host ''
    Write-Host "  Step $number of $total : $text" -ForegroundColor Cyan
}

<#
    Turn off the console's QuickEdit mode.

    With QuickEdit on (the Windows default), a single click inside the window
    puts it into selection mode, which SUSPENDS the running process until the
    user presses Escape. During a ten-minute build that looks exactly like a
    hang, and there is nothing on screen to say otherwise.
#>
function Disable-ConsoleQuickEdit {
    try {
        if (-not ('ConsoleMode' -as [type])) {
            Add-Type -Namespace Win32 -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int nStdHandle);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
        }

        $STD_INPUT_HANDLE       = -10
        $ENABLE_QUICK_EDIT_MODE = 0x0040
        $ENABLE_EXTENDED_FLAGS  = 0x0080

        $handle = [Win32.ConsoleMode]::GetStdHandle($STD_INPUT_HANDLE)
        $mode = 0
        if (-not [Win32.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) { return }

        # Clearing QuickEdit only takes effect when the extended flag is set.
        $new = ($mode -band (-bnot $ENABLE_QUICK_EDIT_MODE)) -bor $ENABLE_EXTENDED_FLAGS
        [void][Win32.ConsoleMode]::SetConsoleMode($handle, $new)
    } catch {
        # Not fatal: the worst case is the old click-to-freeze behaviour, which
        # the on-screen warning covers.
    }
}

# --- Docker -----------------------------------------------------------------

function Get-DockerExe {
    $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Docker Desktop does not always add itself to PATH for an already-open
    # session, so check the fixed install locations too.
    foreach ($p in @(
        "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
        "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
    )) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Test-DockerRunning {
    $docker = Get-DockerExe
    if (-not $docker) { return $false }
    try {
        & $docker info 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

<#
    Download with a visible progress bar.

    Uses WebClient rather than HttpClient: System.Net.Http is not loaded by
    default in Windows PowerShell 5.1, so referencing it there fails at runtime.
#>
function Get-FileWithProgress {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$Activity = 'Downloading'
    )

    $client = New-Object System.Net.WebClient
    $client.Headers.Add('User-Agent', 'AIAutoEditorPro-Setup')

    $state = [hashtable]::Synchronized(@{ Percent = 0; Received = 0; Total = 0; Done = $false; Error = $null })

    $onProgress = Register-ObjectEvent -InputObject $client -EventName DownloadProgressChanged -Action {
        $Event.MessageData.Percent  = $EventArgs.ProgressPercentage
        $Event.MessageData.Received = $EventArgs.BytesReceived
        $Event.MessageData.Total    = $EventArgs.TotalBytesToReceive
    } -MessageData $state

    $onDone = Register-ObjectEvent -InputObject $client -EventName DownloadFileCompleted -Action {
        if ($EventArgs.Error) { $Event.MessageData.Error = $EventArgs.Error.Message }
        $Event.MessageData.Done = $true
    } -MessageData $state

    try {
        $client.DownloadFileAsync([Uri]$Url, $Destination)

        while (-not $state.Done) {
            $mb    = [math]::Round($state.Received / 1MB, 1)
            $mbAll = [math]::Round($state.Total / 1MB, 1)
            $status = if ($state.Total -gt 0) { "$mb MB of $mbAll MB" } else { "$mb MB" }

            Write-Progress -Activity $Activity -Status $status -PercentComplete $state.Percent
            # Also print to the log every 10%, so a captured log shows progress
            # even though Write-Progress does not appear in a transcript.
            Start-Sleep -Milliseconds 400
        }

        Write-Progress -Activity $Activity -Completed

        if ($state.Error) { throw "$Activity failed: $($state.Error)" }
        if (-not (Test-Path $Destination)) { throw "$Activity produced no file." }
    } finally {
        Unregister-Event -SourceIdentifier $onProgress.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $onDone.Name     -ErrorAction SilentlyContinue
        $client.Dispose()
    }
}

function Install-DockerDesktop {
    Write-Warn 'Docker Desktop is not installed.'
    Write-Info 'It supplies the database, cache and video engine this app runs on.'
    Write-Info 'Downloading it now - about 550 MB. This is the only download needed.'
    Write-Host ''

    $installer = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    Get-FileWithProgress -Url $DockerUrl -Destination $installer -Activity 'Downloading Docker Desktop'

    $sizeMb = [math]::Round((Get-Item $installer).Length / 1MB, 1)
    Write-Ok "Downloaded ($sizeMb MB)"

    Write-Host ''
    Write-Info 'Running the Docker Desktop installer.'
    Write-Warn 'Windows will ask for permission. Click Yes, then wait - this takes a few minutes.'
    Write-Host ''

    $proc = Start-Process -FilePath $installer `
                          -ArgumentList 'install', '--quiet', '--accept-license' `
                          -Wait -PassThru -Verb RunAs

    if ($proc.ExitCode -ne 0) {
        throw "The Docker Desktop installer exited with code $($proc.ExitCode). Install it manually from https://www.docker.com/products/docker-desktop/ then run this again."
    }

    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    Write-Ok 'Docker Desktop installed'
    Write-Host ''
    Write-Warn 'Windows normally needs a RESTART before Docker will run.'
    Write-Warn 'If the next step times out, restart Windows and launch this again.'
}

function Start-DockerEngine {
    foreach ($p in @(
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe"
    )) {
        if ($p -and (Test-Path $p)) {
            Write-Info 'Starting Docker Desktop...'
            Start-Process $p -ErrorAction SilentlyContinue
            break
        }
    }

    Write-Info 'Waiting for the Docker engine. A cold start takes one to three minutes.'
    $deadline = (Get-Date).AddMinutes(6)
    $tick = 0

    while ((Get-Date) -lt $deadline) {
        if (Test-DockerRunning) {
            Write-Progress -Activity 'Waiting for Docker' -Completed
            Write-Ok 'Docker engine ready'
            return $true
        }
        $tick++
        $left = [int]((($deadline - (Get-Date))).TotalSeconds)
        Write-Progress -Activity 'Waiting for Docker' -Status "Still starting - up to $left seconds left" `
                       -PercentComplete ([math]::Min(99, $tick * 3))
        if ($tick % 10 -eq 0) { Write-Info "still waiting for Docker ($left seconds left)" }
        Start-Sleep -Seconds 3
    }

    Write-Progress -Activity 'Waiting for Docker' -Completed
    return $false
}

# --- WSL ---------------------------------------------------------------------

<#
    Docker Desktop runs its engine inside WSL 2. A Windows install that still
    has the old inbox WSL cannot start it, and Docker reports only
    "WSL needs updating" in its own window - the engine never comes up, so
    waiting for it is futile. Detect that here instead of timing out.
#>
function Get-WindowsBuild {
    # CurrentBuildNumber is authoritative; OSVersion lies under app compat
    # shims on some Windows 10 builds.
    try {
        return [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    } catch {
        return [int][System.Environment]::OSVersion.Version.Build
    }
}

function Test-WslCurrent {
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) { return $false }

    # "wsl --version" exists only in the modern (Store) WSL. The old inbox
    # version fails the switch, which is exactly the build Docker rejects.
    try {
        $null = & wsl.exe --version 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-WindowsFeaturesEnabled {
    # Windows 10 ships both features disabled by default. Without them WSL 2
    # cannot run at all, and "wsl --update" will not fix it.
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        try {
            $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction Stop).State
            if ($state -ne 'Enabled') { return $false }
        } catch {
            # Get-WindowsOptionalFeature needs elevation on some builds; treat
            # an unreadable state as "cannot confirm" rather than "disabled".
            return $true
        }
    }
    return $true
}

function Enable-WindowsFeatures {
    Write-Info 'Enabling the Windows features WSL needs. Windows will ask for permission.'
    $cmd = 'dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart; ' +
           'dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart'
    try {
        $proc = Start-Process -FilePath 'powershell.exe' `
                              -ArgumentList '-NoProfile', '-Command', $cmd `
                              -Wait -PassThru -Verb RunAs
        return ($proc.ExitCode -eq 0)
    } catch {
        Write-Bad "Could not enable the Windows features: $($_.Exception.Message)"
        return $false
    }
}

function Repair-Wsl {
    $build = Get-WindowsBuild
    Write-Info "Windows build $build"

    if ($build -lt 18362) {
        Write-Bad 'This build of Windows 10 is too old for WSL 2, which Docker requires.'
        Write-Host ''
        Write-Host '   Update Windows first: Settings > Update and Security > Windows Update.' -ForegroundColor White
        Write-Host '   You need at least version 1903 (build 18362); 22H2 is recommended.' -ForegroundColor White
        Write-Host ''
        return $false
    }

    if (-not (Test-WindowsFeaturesEnabled)) {
        if (-not (Enable-WindowsFeatures)) { return $false }
        Write-Ok 'Windows features enabled'
    }

    if ($build -ge 19041) {
        Write-Info 'Updating WSL. Windows will ask for permission - click Yes.'
        try {
            $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList '--update' -Wait -PassThru -Verb RunAs
            if ($proc.ExitCode -ne 0) {
                Write-Info 'Update did not apply. Trying a full WSL install...'
                $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install', '--no-distribution' `
                                      -Wait -PassThru -Verb RunAs
            }
            if ($proc.ExitCode -ne 0) { return $false }
        } catch {
            Write-Bad "Could not run the WSL updater: $($_.Exception.Message)"
            return $false
        }
    } else {
        # Windows 10 builds 18362-19040 have no "wsl --update"; the kernel must
        # be installed from Microsoft's standalone package.
        Write-Info 'This Windows build needs the WSL 2 kernel package. Downloading it...'
        $msi = Join-Path $env:TEMP 'wsl_update_x64.msi'
        try {
            Get-FileWithProgress -Url 'https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi' `
                                 -Destination $msi -Activity 'Downloading WSL 2 kernel'
            $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "\"$msi\"", '/quiet', '/norestart' `
                                  -Wait -PassThru -Verb RunAs
            if ($proc.ExitCode -ne 0) { return $false }
            Remove-Item $msi -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Bad "Could not install the WSL 2 kernel: $($_.Exception.Message)"
            return $false
        }
    }

    Write-Ok 'WSL updated'
    return $true
}

function Show-WslInstructions {
    $build = Get-WindowsBuild
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host '   ACTION NEEDED: update WSL, then RESTART Windows' -ForegroundColor Yellow
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "   Your Windows build: $build" -ForegroundColor Gray
    Write-Host ''
    Write-Host '   1. Press Start, type: powershell' -ForegroundColor White
    Write-Host '   2. Right-click Windows PowerShell, choose Run as administrator' -ForegroundColor White
    Write-Host '   3. Run these commands, one at a time:' -ForegroundColor White
    Write-Host ''
    Write-Host '        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart' -ForegroundColor Cyan
    Write-Host '        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart' -ForegroundColor Cyan

    if ($build -ge 19041) {
        Write-Host '        wsl --update' -ForegroundColor Cyan
    } else {
        Write-Host ''
        Write-Host '      Then download and run the WSL 2 kernel update:' -ForegroundColor White
        Write-Host '        https://aka.ms/wsl2kernel' -ForegroundColor Cyan
    }

    Write-Host ''
    Write-Host '   4. RESTART Windows. This is required - the changes do not' -ForegroundColor White
    Write-Host '      take effect until you reboot.' -ForegroundColor White
    Write-Host '   5. Launch AI Auto Editor Pro again from the Start menu.' -ForegroundColor White
    Write-Host ''
    Write-Host '   If Docker still refuses after rebooting, virtualization may be' -ForegroundColor Gray
    Write-Host '   turned off in your BIOS. Open Task Manager > Performance > CPU' -ForegroundColor Gray
    Write-Host '   and check that Virtualization says Enabled.' -ForegroundColor Gray
    Write-Host ''
}

# --- Settings ---------------------------------------------------------------

function New-EnvFile {
    $envPath     = Join-Path $InstallRoot '.env'
    $examplePath = Join-Path $InstallRoot '.env.example'

    if (Test-Path $envPath) {
        Write-Ok 'Using the existing settings file'
        return
    }
    if (-not (Test-Path $examplePath)) {
        throw ".env.example is missing from $InstallRoot. The installation looks incomplete - reinstall."
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
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $docker = Get-DockerExe
    if (-not $docker) { throw 'docker.exe was not found.' }

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
    $deadline = (Get-Date).AddMinutes(6)
    $tick = 0

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

        $tick++
        $left = [int]((($deadline - (Get-Date))).TotalSeconds)
        Write-Progress -Activity 'Starting' -Status "up to $left seconds left" `
                       -PercentComplete ([math]::Min(99, $tick * 3))
        if ($tick % 10 -eq 0) { Write-Info "still starting ($left seconds left)" }
        Start-Sleep -Seconds 3
    }

    Write-Progress -Activity 'Starting' -Completed
    return $false
}

# --- Actions ----------------------------------------------------------------

function Invoke-Start {
    Disable-ConsoleQuickEdit

    Write-Head 'AI Auto Editor Pro'
    Write-Host "  Install folder: $InstallRoot" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Do NOT click inside this window while it works.' -ForegroundColor Yellow
    Write-Host '  On Windows a click pauses the process. If the title bar ever shows' -ForegroundColor DarkGray
    Write-Host '  "Select", press Escape to resume.' -ForegroundColor DarkGray

    Write-Step 1 4 'Checking Docker Desktop'
    if (-not (Get-DockerExe)) {
        Install-DockerDesktop
    } else {
        Write-Ok 'Docker Desktop is installed'
    }

    Write-Step 2 4 'Starting the Docker engine'
    if (Test-DockerRunning) {
        Write-Ok 'Docker engine already running'
    } else {
        # Check WSL first: Docker cannot start without it, and waiting six
        # minutes for an engine blocked on an old WSL helps nobody.
        if (-not (Test-WslCurrent)) {
            if (-not (Repair-Wsl)) {
                Show-WslInstructions
                return 1
            }
            Write-Host ''
            Write-Warn 'WSL was updated. Windows must RESTART before Docker can start.'
            Write-Warn 'Restart now, then launch AI Auto Editor Pro again.'
            Write-Host ''
            return 1
        }
        Write-Ok 'WSL is up to date'

        if (-not (Start-DockerEngine)) {
            Write-Bad 'Docker did not become ready in time.'
            Write-Host ''
            Write-Host '  Most likely causes:' -ForegroundColor Gray
            Write-Host '    - Windows has not been restarted since Docker was installed' -ForegroundColor Gray
            Write-Host '    - Docker Desktop is showing an error of its own - open it and look' -ForegroundColor Gray
            Write-Host ''
            Write-Host '  If Docker Desktop says "WSL needs updating":' -ForegroundColor Gray
            Show-WslInstructions
            return 1
        }
    }

    Write-Step 3 4 'Preparing settings'
    New-EnvFile
    $webPort = [int](Get-EnvValue 'WEB_PORT' '3000')
    $apiPort = [int](Get-EnvValue 'API_PORT' '4000')
    Write-Ok "Web port $webPort, API port $apiPort"

    Write-Step 4 4 'Building and starting the platform'
    Write-Info 'The FIRST run compiles everything. Expect 5 to 10 minutes.'
    Write-Info 'Docker prints its progress below - it is working even when it looks stuck.'
    Write-Warn 'Do not click in this window. A click pauses it (title shows "Select"; press Escape).'
    Write-Host ''

    $code = Invoke-Compose @('up', '-d', '--build')
    if ($code -ne 0) {
        Write-Bad "Startup failed with exit code $code."
        Write-Host ''
        Write-Host '  The output above says why. Common causes:' -ForegroundColor Gray
        Write-Host '    - no internet connection while downloading base images' -ForegroundColor Gray
        Write-Host '    - not enough disk space (this needs about 6 GB free)' -ForegroundColor Gray
        return 1
    }

    if (-not (Wait-ForApp -WebPort $webPort -ApiPort $apiPort)) {
        Write-Bad 'The containers started but the app never answered.'
        Write-Host ''
        Write-Host '  Run the Diagnose shortcut, or inspect the logs with:' -ForegroundColor Gray
        Write-Host '    docker compose logs --tail=80' -ForegroundColor White
        return 1
    }

    Write-Host ''
    Write-Ok "API   http://localhost:$apiPort"
    Write-Ok "App   http://localhost:$webPort"
    Start-Process "http://localhost:$webPort"

    Write-Head 'Next steps'
    Write-Host '    1. Create an account - the first one becomes the administrator.' -ForegroundColor Gray
    Write-Host '    2. Open API management and add a Google Gemini API key.' -ForegroundColor Gray
    Write-Host '       Get one free at https://aistudio.google.com/apikey' -ForegroundColor Gray
    Write-Host '    3. Create a project and upload a voiceover.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Leave this window open or close it - the app keeps running.' -ForegroundColor DarkGray
    Write-Host '  Stop it from the Start menu. Your data is kept.' -ForegroundColor DarkGray
    return 0
}

function Invoke-Stop {
    Write-Head 'Stopping AI Auto Editor Pro'
    if (-not (Test-DockerRunning)) {
        Write-Warn 'Docker is not running, so nothing is up.'
        return 0
    }
    $null = Invoke-Compose @('down')
    Write-Ok 'Stopped. Your projects and media are kept.'
    return 0
}

function Invoke-Doctor {
    Write-Head 'Diagnostics'
    Write-Host "  Install folder : $InstallRoot" -ForegroundColor DarkGray
    Write-Host "  PowerShell     : $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray
    Write-Host "  Windows        : $([System.Environment]::OSVersion.Version)" -ForegroundColor DarkGray
    Write-Host ''

    $docker = Get-DockerExe
    if (-not $docker) {
        Write-Bad 'Docker Desktop is not installed.'
        Write-Host '  Fix: use the Start shortcut - it downloads and installs Docker for you.' -ForegroundColor White
        return 1
    }
    Write-Ok "Docker found at $docker"

    if (-not (Test-WslCurrent)) {
        Write-Bad 'WSL is missing or too old - Docker cannot start without it.'
        Show-WslInstructions
        return 1
    }
    Write-Ok 'WSL is up to date'

    if (-not (Test-DockerRunning)) {
        Write-Bad 'Docker Desktop is installed but the engine is not running.'
        Write-Host '  Fix: open Docker Desktop, wait for the whale to stop animating, then Start again.' -ForegroundColor White
        Write-Host '  If it reports "WSL needs updating":' -ForegroundColor White
        Show-WslInstructions
        return 1
    }
    Write-Ok 'Docker engine running'

    if (-not (Test-Path (Join-Path $InstallRoot '.env'))) {
        Write-Warn 'No settings file yet - it is created on first start.'
    }

    $webPort = [int](Get-EnvValue 'WEB_PORT' '3000')
    $apiPort = [int](Get-EnvValue 'API_PORT' '4000')
    Write-Ok "Configured ports: web $webPort, API $apiPort"

    Write-Host ''
    Write-Host '  Containers' -ForegroundColor White
    $null = Invoke-Compose @('ps')
    Write-Host ''

    $answered = $false
    foreach ($p in @($webPort, 3000)) {
        try {
            $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$p"
            Write-Ok "http://localhost:$p answers"
            if ($p -ne $webPort) {
                Write-Warn "The app is on port $p, not the $webPort you configured."
                Write-Host '  Fix: Stop from the Start menu, then Start again.' -ForegroundColor White
            }
            $answered = $true
            break
        } catch {
            Write-Bad "http://localhost:$p refused"
        }
    }

    if (-not $answered) {
        Write-Host ''
        Write-Host '  Nothing is answering. Use the Start shortcut, or inspect:' -ForegroundColor Gray
        Write-Host '    docker compose logs --tail=80' -ForegroundColor White
        return 1
    }
    return 0
}

# --- Entry point ------------------------------------------------------------

$exitCode = 1
try {
    switch ($Action) {
        'Start'  { $exitCode = Invoke-Start }
        'Stop'   { $exitCode = Invoke-Stop }
        'Doctor' { $exitCode = Invoke-Doctor }
    }
} catch {
    Write-Host ''
    Write-Bad $_.Exception.Message
    Write-Host ''
    Write-Host '  Details for support:' -ForegroundColor DarkGray
    Write-Host "    $($_.ScriptStackTrace)" -ForegroundColor DarkGray
    $exitCode = 1
}

exit $exitCode
