<#
    Creates .env from .env.example, filling in the two secrets the platform
    refuses to start without.

    JWT_SECRET     signs access tokens
    ENCRYPTION_KEY encrypts stored Gemini API keys (AES-256-GCM, needs 32 bytes)

    Both are generated with the OS cryptographic RNG, not Get-Random.
#>

$ErrorActionPreference = 'Stop'

# Run relative to the repository root, which is the parent of \scripts.
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path '.env.example')) {
    Write-Error '.env.example is missing — cannot create .env.'
    exit 1
}

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

$jwtBytes = New-Object byte[] 48
$rng.GetBytes($jwtBytes)
$jwtSecret = [Convert]::ToBase64String($jwtBytes)

# Exactly 32 bytes, hex-encoded: config/env.ts rejects any other length.
$keyBytes = New-Object byte[] 32
$rng.GetBytes($keyBytes)
$encryptionKey = ([BitConverter]::ToString($keyBytes)).Replace('-', '').ToLower()

$text = Get-Content '.env.example' -Raw
$text = [regex]::Replace($text, '(?m)^JWT_SECRET=.*$',     'JWT_SECRET=' + $jwtSecret)
$text = [regex]::Replace($text, '(?m)^ENCRYPTION_KEY=.*$', 'ENCRYPTION_KEY=' + $encryptionKey)

# UTF-8 without a BOM: docker compose does not strip one, and a BOM would end
# up inside the first variable name.
[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location) '.env'),
    $text,
    (New-Object System.Text.UTF8Encoding $false)
)

exit 0
