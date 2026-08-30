<#
    Polls the API and the web app until both answer, or five minutes pass.
    Exit code 0 means the platform is up; 1 means it never came up.

    Ports default to the compose defaults and can be overridden so the check
    follows a custom WEB_PORT / API_PORT.
#>
param(
    [int]$WebPort = 3000,
    [int]$ApiPort = 4000
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

$deadline = (Get-Date).AddMinutes(5)

while ((Get-Date) -lt $deadline) {
    $apiUp = $false
    $webUp = $false

    try {
        $api = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$ApiPort/ready"
        if ($api.StatusCode -eq 200) { $apiUp = $true }
    } catch { }

    try {
        $web = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$WebPort"
        if ($web.StatusCode -eq 200) { $webUp = $true }
    } catch { }

    if ($apiUp -and $webUp) {
        Write-Host ''
        exit 0
    }

    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
}

Write-Host ''
exit 1
