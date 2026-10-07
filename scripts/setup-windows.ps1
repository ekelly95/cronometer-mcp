[CmdletBinding()]
param(
    [string]$TimeZone,
    [switch]$SkipClientRegistration,
    [switch]$InternalFunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$Description,
        [Parameter(Mandatory)] [scriptblock]$Command
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Read-YesNo {
    param(
        [Parameter(Mandatory)] [string]$Prompt,
        [bool]$DefaultYes = $false
    )

    $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    $answer = (Read-Host "$Prompt $suffix").Trim()
    if ($answer -eq '') { return $DefaultYes }
    return $answer -match '^(?i:y|yes)$'
}

function Protect-DataDirectory {
    param([Parameter(Mandatory)] [string]$Path)

    # Session cookies and the DPAPI ciphertext should not inherit broad permissions from a parent folder.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($identity.User)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Set-CodexWriteApprovalMode {
    param([string]$CodexRoot)

    if ([string]::IsNullOrWhiteSpace($CodexRoot)) {
        $configuredRoot = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
        $CodexRoot = if ([string]::IsNullOrWhiteSpace($configuredRoot)) {
            Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
        } else {
            $configuredRoot
        }
    }
    $configPath = Join-Path $CodexRoot 'config.toml'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'Codex registered the server but its config.toml could not be found to enable write prompts.'
    }

    $text = [IO.File]::ReadAllText($configPath)
    $headerPattern = '(?m)^\[mcp_servers\.(?:cronometer-personal|"cronometer-personal")\][ \t]*\r?$'
    $header = [regex]::Match($text, $headerPattern)
    if (-not $header.Success) {
        throw 'Codex registered the server but its configuration section could not be found.'
    }

    $sectionStart = $header.Index
    $nextHeader = [regex]::new('(?m)^\[').Match($text, $header.Index + $header.Length)
    $sectionEnd = if ($nextHeader.Success) { $nextHeader.Index } else { $text.Length }
    $section = $text.Substring($sectionStart, $sectionEnd - $sectionStart)
    $approval = [regex]::Match(
        $section,
        '(?m)^[ \t]*default_tools_approval_mode[ \t]*=[^\r\n]*'
    )
    if ($approval.Success) {
        $updatedSection = $section.Substring(0, $approval.Index) +
            'default_tools_approval_mode = "writes"' +
            $section.Substring($approval.Index + $approval.Length)
    } else {
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $insertAt = $header.Index - $sectionStart + $header.Length
        $updatedSection = $section.Substring(0, $insertAt) +
            $newline + 'default_tools_approval_mode = "writes"' +
            $section.Substring($insertAt)
    }

    $updated = $text.Substring(0, $sectionStart) + $updatedSection + $text.Substring($sectionEnd)
    $temporary = Join-Path $CodexRoot ('.config-cronometer-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $updated, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $configPath, $true)
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Resolve-StablePowerShellPath {
    <#
        The path written into an MCP client's config has to outlive PowerShell
        updates. Run from the Microsoft Store build, `(Get-Command pwsh).Source` is
        `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__...\pwsh.exe`,
        and that folder is replaced on the next Store update. A registration
        pointing there stops starting, and the client only says the server failed.

        The app execution alias in %LOCALAPPDATA%\Microsoft\WindowsApps is what the
        Store keeps pointing at the current version, so that is what gets written.
        Every other install location is already stable and passes through as is.
    #>
    param(
        [Parameter(Mandatory)] [string]$Source,
        [string]$LocalAppData = $env:LOCALAPPDATA
    )

    if ($Source -notmatch '\\WindowsApps\\Microsoft\.PowerShell_[^\\]+\\pwsh\.exe$') {
        return $Source
    }
    if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) {
        $alias = Join-Path (Join-Path (Join-Path $LocalAppData 'Microsoft') 'WindowsApps') 'pwsh.exe'
        if (Test-Path -LiteralPath $alias) {
            return $alias
        }
    }
    Write-Warning "PowerShell is the Microsoft Store build and its app execution alias is turned off, so the registration will use $Source. That path changes when the Store updates PowerShell; re-run this setup after an update, or turn the pwsh alias back on in Settings > Apps > Advanced app settings > App execution aliases."
    return $Source
}

function Get-PropertyName {
    <#
        `$object.PSObject.Properties.Name` throws under Set-StrictMode when the
        object has no properties, which is exactly the first-run case. Piping
        enumerates an empty collection safely instead.

        The leading comma matters: PowerShell unrolls an empty array on return, so
        a bare `return @()` reaches the caller as $null and the next `.Count` throws.
        Wrapping keeps it an array whatever it contains.
    #>
    param($InputObject)

    if ($null -eq $InputObject) { return , @() }
    return , @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
}

function Register-ClaudeDesktopServer {
    <#
        Claude Desktop has no CLI to register an MCP server, so its config file has
        to be edited directly. That file is not just a server list — it also holds
        the app's own preferences, several levels deep — so it is written to fail
        rather than to half-succeed: back up, refuse anything that lost a key, and
        never touch an existing entry of the same name.

        The logic itself lives in scripts/lib/desktop-config.mjs and is shared with
        the macOS setup script. It was moved out of PowerShell deliberately: two
        implementations of something this fiddly drift apart, and the copy that
        drifts is the one nobody is running today. Node also runs on both platforms,
        so the same vitest suite covers it here and there.

        This wrapper stays because the behaviour is worth testing through the path
        Windows actually uses, not just directly.
    #>
    param(
        [Parameter(Mandatory)] [string]$Runner,
        [Parameter(Mandatory)] [string]$PowerShellPath,
        [string]$ConfigPath
    )

    $writer = Join-Path (Join-Path $PSScriptRoot 'lib') 'desktop-config.mjs'
    if (-not (Test-Path -LiteralPath $writer -PathType Leaf)) {
        throw "The Claude Desktop registration helper is missing: $writer"
    }

    $arguments = @($writer, '--command', $PowerShellPath)
    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        $arguments += @('--config', $ConfigPath)
    }
    # Everything after `--` becomes the launcher's argument list, kept as separate
    # elements so a path containing a space is never re-split by a shell.
    $arguments += @('--', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Runner)

    $output = (& node @arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw $output
    }
    return $output
}

if ($InternalFunctionsOnly) {
    return
}

if (-not $IsWindows) {
    throw 'This setup script is for native Windows. The server itself remains portable.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $projectRoot '.venv-live'
$python = Join-Path $venv 'Scripts\python.exe'
$lockFile = Join-Path $projectRoot 'python\requirements-live.lock'
$runner = Join-Path $PSScriptRoot 'run-mcp.ps1'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'CronometerPersonalMcp'
$configurationPath = Join-Path $dataDirectory 'live-config.json'

foreach ($command in @('node', 'npm', 'uv')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required but was not found on PATH."
    }
}

Push-Location $projectRoot
try {
    Invoke-Checked 'npm dependency installation' { npm ci }
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        Invoke-Checked 'Python 3.12 environment creation' { uv venv $venv --python 3.12 }
    }
    Invoke-Checked 'locked Python dependency installation' {
        uv pip sync $lockFile --python $python --require-hashes
    }
    Invoke-Checked 'TypeScript verification' { npm run typecheck }
    Invoke-Checked 'TypeScript build and tests' { npm test }
    Invoke-Checked 'Python connector tests' { npm run test:python }
} finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($TimeZone)) {
    $enteredTimeZone = (Read-Host 'Cronometer diary IANA timezone [America/New_York — Recommended]').Trim()
    $TimeZone = if ($enteredTimeZone -eq '') { 'America/New_York' } else { $enteredTimeZone }
}
Invoke-Checked 'Timezone validation' {
    node -e "new Intl.DateTimeFormat('en-US',{timeZone:process.argv[1]}).format(new Date())" $TimeZone
}

Write-Host ''
Write-Host 'Live access uses an unsupported Cronometer web interface. It may break, and Cronometer could restrict the account.'
$enable = (Read-Host 'Type ENABLE to accept that risk and enable live read/write access').Trim()
if ($enable -cne 'ENABLE') {
    throw 'Live access was not enabled. No credential configuration was written.'
}

if ((Test-Path -LiteralPath $configurationPath) -and -not (Read-YesNo 'Replace the saved Cronometer sign-in?')) {
    throw 'The existing sign-in was left unchanged.'
}

$username = (Read-Host 'Cronometer username or email').Trim()
if ([string]::IsNullOrWhiteSpace($username) -or $username.Length -gt 320) {
    throw 'A valid Cronometer username or email is required.'
}
$password = Read-Host 'Cronometer password (encrypted for this Windows account)' -AsSecureString
if ($password.Length -eq 0) {
    throw 'A Cronometer password is required.'
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
Protect-DataDirectory $dataDirectory
# Created before the ACL is inherited downward, so downloaded exports — the whole
# diary, per meal — are protected the same way the credentials are.
New-Item -ItemType Directory -Path (Join-Path $dataDirectory 'exports') -Force | Out-Null
$saved = [ordered]@{
    version = 1
    live_enabled = $true
    timezone = $TimeZone
    username = $username
    # Names the store rather than leaving it to be inferred from which field is
    # present. A macOS configuration copied here would otherwise fail at DPAPI
    # decryption with a message about this Windows account, which points at the
    # wrong problem entirely.
    credential_source = 'dpapi'
    password_dpapi = ConvertFrom-SecureString $password
}
$saved | ConvertTo-Json | Set-Content -LiteralPath $configurationPath -Encoding UTF8

Write-Host ''
Write-Host 'The server is built, tested, and configured. No plaintext password was written to the project or an MCP config.'

if (-not $SkipClientRegistration) {
    $powerShell = Resolve-StablePowerShellPath (Get-Command pwsh -ErrorAction Stop).Source

    if (Get-Command codex -ErrorAction SilentlyContinue) {
        if (Read-YesNo 'Register cronometer-personal with Codex for this Windows account?' $true) {
            & codex mcp get cronometer-personal *>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'Codex already has an MCP server named cronometer-personal; it was not overwritten.'
            } else {
                Invoke-Checked 'Codex MCP registration' {
                    codex mcp add cronometer-personal -- $powerShell -NoProfile -ExecutionPolicy Bypass -File $runner
                }
            }
            # Registration has already happened by this point. If the approval-mode
            # edit fails, aborting would leave the server registered and silently
            # NOT prompting on writes, which is the one outcome worth shouting about.
            try {
                Set-CodexWriteApprovalMode
                Write-Host 'Codex is configured to prompt for every tool not marked read-only.'
            } catch {
                Write-Warning ('Codex has the server registered, but write prompting could NOT be enabled: ' + $_.Exception.Message)
                Write-Warning 'Account-changing tools may run without asking until you fix this.'
                Write-Warning 'Add this line under [mcp_servers.cronometer-personal] in Codex''s config.toml:'
                Write-Warning '    default_tools_approval_mode = "writes"'
            }
        }
    }

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        if (Read-YesNo 'Register cronometer-personal with Claude Code for this Windows account?' $true) {
            & claude mcp get cronometer-personal *>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'Claude Code already has an MCP server named cronometer-personal; it was not overwritten.'
            } else {
                Invoke-Checked 'Claude Code MCP registration' {
                    claude mcp add --scope user cronometer-personal -- $powerShell -NoProfile -ExecutionPolicy Bypass -File $runner
                }
            }
            Write-Host 'Claude Code needs no approval setting: every account-changing tool asks the server to require a person, on every call.'
        }
    }

    $desktopConfig = Join-Path (Join-Path $env:APPDATA 'Claude') 'claude_desktop_config.json'
    if (Test-Path -LiteralPath (Split-Path -Parent $desktopConfig) -PathType Container) {
        if (Read-YesNo 'Register cronometer-personal with Claude Desktop?' $true) {
            try {
                Write-Host (Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $powerShell)
            } catch {
                Write-Warning ('Claude Desktop registration failed and nothing was changed: ' + $_.Exception.Message)
                Write-Warning "You can add it by hand under mcpServers in $desktopConfig."
            }
        }
    }
}

Write-Host ''
Write-Host 'Restart the client you registered, then ask it to call cronometer_status before the first connection check.'
