[CmdletBinding()]
param(
    # stdio is the local server every MCP client launches. http is the remote
    # connector for Claude's hosted apps, started once and left running; see REMOTE.md.
    [ValidateSet('stdio', 'http')]
    [string]$Transport = 'stdio'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = if ($Transport -eq 'http') {
    Join-Path $projectRoot 'dist\http\main.js'
} else {
    Join-Path $projectRoot 'dist\mcp\main.js'
}
$dataDirectory = Join-Path $env:LOCALAPPDATA 'CronometerPersonalMcp'
$configurationPath = Join-Path $dataDirectory 'live-config.json'
$remoteDirectory = Join-Path $dataDirectory 'remote'
$remoteConfigurationPath = Join-Path $remoteDirectory 'remote-config.json'

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw 'Cronometer MCP is not built. Run scripts\setup-windows.ps1 first.'
}
if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
    throw 'Cronometer MCP is not configured. Run scripts\setup-windows.ps1 first.'
}

# The bridge can only check that CRONOMETER_DATA_DIR is set, not that the directory
# is actually protected — Python cannot read a Windows ACL without extra packages.
# This is the one component that can, and it runs on every start, so the check
# belongs here. The directory holds the DPAPI ciphertext and the session cookie;
# an inherited ACL would hand both to SYSTEM and every local administrator.
$acl = Get-Acl -LiteralPath $dataDirectory
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not $acl.AreAccessRulesProtected) {
    throw "The Cronometer data directory inherits permissions from its parent: $dataDirectory. Re-run scripts\setup-windows.ps1 to restrict it."
}
foreach ($rule in $acl.Access) {
    $identity = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
    if ($identity -ne $currentUser) {
        throw "The Cronometer data directory grants access to $($rule.IdentityReference): $dataDirectory. Re-run scripts\setup-windows.ps1 to restrict it."
    }
}

$configuration = Get-Content -LiteralPath $configurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($configuration.version -ne 1 -or $configuration.live_enabled -ne $true) {
    throw 'The saved Cronometer MCP configuration is invalid or live access is disabled.'
}
if (
    $configuration.username -isnot [string] -or
    [string]::IsNullOrWhiteSpace($configuration.username) -or
    $configuration.username.Length -gt 320 -or
    $configuration.username.IndexOfAny([char[]]"`r`n`0") -ge 0
) {
    throw 'The saved Cronometer username is invalid.'
}
if (
    $configuration.timezone -isnot [string] -or
    [string]::IsNullOrWhiteSpace($configuration.timezone) -or
    $configuration.timezone.Length -gt 100
) {
    throw 'The saved Cronometer diary timezone is invalid.'
}
# Absent means a configuration written before this field existed, and every one of
# those is a Windows one. Anything else was written on another platform, where the
# password is not in this file at all.
$credentialSource = if ($null -eq $configuration.PSObject.Properties['credential_source']) {
    'dpapi'
} else {
    $configuration.credential_source
}
if ($credentialSource -ne 'dpapi') {
    throw "This configuration stores its password with '$credentialSource', which this launcher cannot read. It was written on another platform; re-run scripts\setup-windows.ps1 on this machine."
}
if ($configuration.password_dpapi -isnot [string] -or $configuration.password_dpapi.Length -gt 65536) {
    throw 'The saved Cronometer password is invalid.'
}

# DPAPI ties the encrypted value to this Windows account, avoiding plaintext secrets in MCP configs.
$securePassword = ConvertTo-SecureString $configuration.password_dpapi
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
if ([string]::IsNullOrEmpty($plainPassword)) {
    throw 'The saved Cronometer password could not be decrypted for this Windows account.'
}

$remote = $null
if ($Transport -eq 'http') {
    if (-not (Test-Path -LiteralPath $remoteConfigurationPath -PathType Leaf)) {
        throw 'The remote connector is not configured. Run scripts\setup-remote.ps1 first.'
    }
    # The remote directory sits inside the protected one and inherits its ACL. A rule
    # added to it directly would bypass the check above, so it is checked too.
    foreach ($rule in (Get-Acl -LiteralPath $remoteDirectory).Access) {
        $identity = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
        if ($identity -ne $currentUser) {
            throw "The remote connector directory grants access to $($rule.IdentityReference): $remoteDirectory. Remove that permission or delete the directory and re-run scripts\setup-remote.ps1."
        }
    }
    $remote = Get-Content -LiteralPath $remoteConfigurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        $remote.version -ne 1 -or
        $remote.public_url -isnot [string] -or
        -not $remote.public_url.StartsWith('https://') -or
        $remote.owner_password_hash -isnot [string] -or
        -not $remote.owner_password_hash.StartsWith('scrypt$') -or
        # Parenthesised: PowerShell gives -and and -or the same precedence.
        (($remote.listen_port -isnot [long]) -and ($remote.listen_port -isnot [int]))
    ) {
        throw 'The saved remote connector configuration is invalid. Re-run scripts\setup-remote.ps1.'
    }
}

$exitCode = 1
try {
    $env:CRONOMETER_LIVE_ENABLED = '1'
    $env:CRONOMETER_USERNAME = $configuration.username
    $env:CRONOMETER_PASSWORD = $plainPassword
    $env:CRONOMETER_TIMEZONE = $configuration.timezone
    $env:CRONOMETER_DATA_DIR = $dataDirectory
    # Downloaded exports are the whole diary, per meal, so they live inside the same
    # ACL-protected directory as the credentials rather than wherever a browser put
    # them. The server refuses to read exports at all if this is unset — it will not
    # guess a location for files like these.
    $env:CRONOMETER_EXPORT_DIR = Join-Path $dataDirectory 'exports'
    $env:CRONOMETER_PYTHON = Join-Path $projectRoot '.venv-live\Scripts\python.exe'

    if ($null -ne $remote) {
        # Its own Cronometer session file, so the local server and the remote one
        # never rewrite the same .session.json underneath each other.
        $env:CRONOMETER_DATA_DIR = Join-Path $remoteDirectory 'cronometer'
        $env:MCP_STATE_DIR = Join-Path $remoteDirectory 'oauth'
        $env:MCP_PUBLIC_URL = $remote.public_url
        $env:MCP_OWNER_PASSWORD_HASH = $remote.owner_password_hash
        $env:MCP_LISTEN_PORT = [string]$remote.listen_port
        $env:MCP_LOG_FILE = Join-Path $remoteDirectory 'server.log'
    }

    & node $entryPoint
    $exitCode = $LASTEXITCODE
} finally {
    $plainPassword = $null
    Remove-Item Env:CRONOMETER_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_LIVE_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_TIMEZONE -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_EXPORT_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:CRONOMETER_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_STATE_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_PUBLIC_URL -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_OWNER_PASSWORD_HASH -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_LISTEN_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_LOG_FILE -ErrorAction SilentlyContinue
}

exit $exitCode
