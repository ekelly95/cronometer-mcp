<#
    Sets up the remote connector: the same server over HTTPS, so Claude's hosted
    apps — the iPhone app in particular — can use it as a custom connector.

    Run scripts\setup-windows.ps1 first; this reuses its Cronometer sign-in. It:
      1. works out the public URL from Tailscale (or asks for it),
      2. asks for an owner password and stores only its scrypt hash,
      3. optionally registers a logon task that keeps the server running.

    Making the URL reachable is a separate, deliberate step: `tailscale funnel`.
    See REMOTE.md for the whole procedure.
#>
[CmdletBinding()]
param(
    [string]$PublicHost,
    [ValidateRange(1024, 65535)]
    [int]$Port = 8787,
    [switch]$SkipTask,
    [switch]$InternalFunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskName = 'Cronometer MCP (remote)'

function ConvertTo-PublicUrl {
    <#
        Tailscale reports the machine's name with DNS's trailing dot
        ("my-pc.tail1234.ts.net."). The URL is what gets typed into Claude and
        becomes the OAuth resource identifier, so it is normalised once, here.
    #>
    param([Parameter(Mandatory)] [string]$HostName)

    $name = $HostName.Trim().TrimEnd('.').ToLowerInvariant()
    if ($name -notmatch '^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') {
        throw "'$HostName' is not a host name. Use the machine's full Tailscale name, such as my-pc.tail1234.ts.net."
    }
    return "https://$name/mcp"
}

function Get-TailscaleHostName {
    <# The machine's MagicDNS name from `tailscale status --json`, or $null if unavailable. #>
    param([string]$StatusJson)

    if ([string]::IsNullOrWhiteSpace($StatusJson)) {
        if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { return $null }
        $StatusJson = (& tailscale status --json 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0) { return $null }
    }
    try {
        $status = $StatusJson | ConvertFrom-Json
    } catch {
        return $null
    }
    $self = $status.PSObject.Properties['Self']
    if ($null -eq $self -or $null -eq $self.Value) { return $null }
    $dns = $self.Value.PSObject.Properties['DNSName']
    if ($null -eq $dns -or [string]::IsNullOrWhiteSpace($dns.Value)) { return $null }
    return ([string]$dns.Value).TrimEnd('.')
}

function New-RemoteConfiguration {
    param(
        [Parameter(Mandatory)] [string]$PublicUrl,
        [Parameter(Mandatory)] [string]$OwnerPasswordHash,
        [Parameter(Mandatory)] [int]$ListenPort
    )

    if (-not $OwnerPasswordHash.StartsWith('scrypt$')) {
        throw 'The owner password hash was not produced by scripts\lib\hash-password.mjs.'
    }
    return [ordered]@{
        version = 1
        public_url = $PublicUrl
        listen_port = $ListenPort
        owner_password_hash = $OwnerPasswordHash
    }
}

if ($InternalFunctionsOnly) {
    return
}

if (-not $IsWindows) {
    throw 'This setup script is for native Windows.'
}

. (Join-Path $PSScriptRoot 'setup-windows.ps1') -InternalFunctionsOnly

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $env:LOCALAPPDATA 'CronometerPersonalMcp'
$remoteDirectory = Join-Path $dataDirectory 'remote'
$remoteConfigurationPath = Join-Path $remoteDirectory 'remote-config.json'
$hasher = Join-Path (Join-Path $PSScriptRoot 'lib') 'hash-password.mjs'
$runner = Join-Path $PSScriptRoot 'run-mcp.ps1'

if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'live-config.json') -PathType Leaf)) {
    throw 'Run scripts\setup-windows.ps1 first: the remote connector uses the same Cronometer sign-in.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\http\main.js') -PathType Leaf)) {
    throw 'The remote connector is not built. Run npm run build first.'
}

# --- Public URL -----------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($PublicHost)) {
    $detected = Get-TailscaleHostName
    if ($null -ne $detected -and (Read-YesNo "Use this machine's Tailscale name, $detected?" $true)) {
        $PublicHost = $detected
    } else {
        $PublicHost = (Read-Host 'Public host name (for example my-pc.tail1234.ts.net)').Trim()
    }
}
$publicUrl = ConvertTo-PublicUrl $PublicHost

# --- Owner password -------------------------------------------------------------------

if ((Test-Path -LiteralPath $remoteConfigurationPath) -and -not (Read-YesNo 'Replace the saved remote connector settings and owner password?')) {
    throw 'The existing remote connector settings were left unchanged.'
}

Write-Host ''
Write-Host 'Choose an owner password. You type it once on the sign-in page Claude opens when you connect;'
Write-Host 'it is the only thing between the internet and your diary, so make it long (12+ characters).'
$first = Read-Host 'Owner password' -AsSecureString
$second = Read-Host 'Owner password again' -AsSecureString
$firstText = [Net.NetworkCredential]::new('', $first).Password
$secondText = [Net.NetworkCredential]::new('', $second).Password
try {
    if ($firstText -cne $secondText) {
        throw 'The two passwords did not match. Nothing was written.'
    }
    # Piped, not passed as an argument: arguments are visible to every process on the machine.
    # stderr is captured with stdout but kept apart from it: a Node warning on a
    # successful run would otherwise become part of the stored hash.
    # Scoped Continue: under Stop, Windows PowerShell turns any stderr line into a throw.
    $output = & { $ErrorActionPreference = 'Continue'; @($firstText | & node $hasher 2>&1) }
    $exitCode = $LASTEXITCODE
    $errors = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | Out-String).Trim()
    $hash = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | Out-String).Trim()
    if ($exitCode -ne 0) {
        throw $(if ($errors -ne '') { $errors } else { $hash })
    }
} finally {
    $firstText = $null
    $secondText = $null
}

New-Item -ItemType Directory -Path $remoteDirectory -Force | Out-Null
$configuration = New-RemoteConfiguration -PublicUrl $publicUrl -OwnerPasswordHash $hash -ListenPort $Port
$configuration | ConvertTo-Json | Set-Content -LiteralPath $remoteConfigurationPath -Encoding UTF8
Write-Host "Saved $remoteConfigurationPath (the password hash only, never the password)."

# --- Logon task -------------------------------------------------------------------------

if (-not $SkipTask -and (Read-YesNo 'Start the remote connector automatically when you sign in to Windows?' $true)) {
    $powerShell = Resolve-StablePowerShellPath (Get-Command pwsh -ErrorAction Stop).Source
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument (
        "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Transport http"
    ) -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    # Interactive: it runs as you, only while you are signed in, and Windows stores no
    # password for it. DPAPI needs exactly that to decrypt the Cronometer password.
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval ([TimeSpan]::FromMinutes(1)) `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Cronometer MCP remote connector for Claude (see REMOTE.md).' -Force | Out-Null
    Start-ScheduledTask -TaskName $script:TaskName
    Write-Host "Registered and started the '$($script:TaskName)' task. Its log is $(Join-Path $remoteDirectory 'server.log')."
} else {
    Write-Host "Start it yourself with: pwsh -File `"$runner`" -Transport http"
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. Publish it:         tailscale funnel --bg $Port"
Write-Host "  2. Check it from outside your network: $($publicUrl -replace '/mcp$', '')/.well-known/oauth-protected-resource/mcp"
Write-Host '  3. In claude.ai on the web: Customize > Connectors > Add custom connector'
Write-Host "     URL: $publicUrl   (leave the OAuth client ID and secret empty)"
Write-Host '  4. Click Connect and sign in with the owner password you just chose.'
Write-Host '  5. Set the write and delete tools to "Needs approval" on the connector page.'
