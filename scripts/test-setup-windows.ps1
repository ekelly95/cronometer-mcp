<#
    Tests for the parts of setup-windows.ps1 that edit files someone else owns.

    Claude Desktop's configuration is the reason this file exists. It has no CLI to
    register an MCP server, so the config has to be rewritten in place — and that
    file holds Desktop's own preferences, nested well past the depth PowerShell's
    JSON writer serialises by default. Getting it wrong loses settings that are not
    ours to lose, and a backup is a consolation rather than a defence.

    Offline, and touches nothing outside its own temporary directory.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'setup-windows.ps1') -InternalFunctionsOnly
. (Join-Path $PSScriptRoot 'setup-remote.ps1') -InternalFunctionsOnly

$script:Failures = 0
$script:Checks = 0

function Assert-That {
    param(
        [Parameter(Mandatory)] [string]$Description,
        [Parameter(Mandatory)] [bool]$Condition
    )

    $script:Checks += 1
    if ($Condition) {
        Write-Host "  ok    $Description"
    } else {
        $script:Failures += 1
        Write-Host "  FAIL  $Description"
    }
}

function New-Workspace {
    param([Parameter(Mandatory)] [string]$Name)

    $path = Join-Path ([IO.Path]::GetTempPath()) ("cronometer-setup-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Write-Host ""
    Write-Host $Name
    return $path
}

# A configuration shaped like the real thing: several servers, an env block, and a
# preferences tree deep enough to be truncated by ConvertTo-Json's default depth.
$RealisticConfig = @'
{
  "mcpServers": {
    "alpha": { "command": "C:\\tools\\alpha.exe", "args": [] },
    "beta": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\dev\\beta\\index.js"],
      "env": { "BETA_LIBRARY": "C:\\Users\\someone\\Library" }
    }
  },
  "userFilesPath": "C:\\Users\\someone\\Claude",
  "preferences": {
    "allowedOrigins": ["https://example.invalid"],
    "emptyObject": {},
    "emptyArray": [],
    "nested": {
      "levelTwo": {
        "levelThree": {
          "levelFour": { "kept": true, "ratio": 0.5, "name": "deep value" }
        }
      }
    }
  }
}
'@

$stub = 'C:\stub\pwsh.exe'
$runner = 'C:\dev\cronometer\scripts\run-mcp.ps1'

try {
    # ---------------------------------------------------------------- 1
    $workspace = New-Workspace 'An existing configuration keeps everything it had'
    $config = Join-Path $workspace 'claude_desktop_config.json'
    Set-Content -LiteralPath $config -Value $RealisticConfig -Encoding UTF8
    $before = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json

    Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $stub -ConfigPath $config | Out-Null
    $after = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json

    Assert-That 'the new server is registered' (
        (Get-PropertyName $after.mcpServers) -contains 'cronometer-personal')
    Assert-That 'the servers that were already there survive' (
        ((Get-PropertyName $after.mcpServers) -contains 'alpha') -and
        ((Get-PropertyName $after.mcpServers) -contains 'beta'))
    Assert-That 'a nested env block survives' (
        $after.mcpServers.beta.env.BETA_LIBRARY -eq $before.mcpServers.beta.env.BETA_LIBRARY)
    Assert-That 'an unrelated top-level key survives' (
        $after.userFilesPath -eq $before.userFilesPath)
    Assert-That 'a value four levels deep survives' (
        $after.preferences.nested.levelTwo.levelThree.levelFour.name -eq 'deep value')
    Assert-That 'a non-string deep value keeps its type' (
        $after.preferences.nested.levelTwo.levelThree.levelFour.ratio -eq 0.5)
    Assert-That 'an array value survives' (
        $after.preferences.allowedOrigins[0] -eq 'https://example.invalid')
    Assert-That 'nothing was truncated to a .NET type name' (
        -not ((Get-Content -LiteralPath $config -Raw) -match 'System\.(Management|Collections|Object)'))
    Assert-That 'the launcher path is passed as separate arguments' (
        ($after.mcpServers.'cronometer-personal'.args -contains '-NoProfile') -and
        ($after.mcpServers.'cronometer-personal'.args -contains $runner))
    Assert-That 'the previous configuration was backed up' (
        @(Get-ChildItem -LiteralPath $workspace -Filter '*.backup-*').Count -eq 1)
    Assert-That 'the backup is byte-identical to what was there before' (
        (Get-Content -LiteralPath (Get-ChildItem -LiteralPath $workspace -Filter '*.backup-*')[0].FullName -Raw).Trim() -eq $RealisticConfig.Trim())

    # ---------------------------------------------------------------- 2
    $workspace = New-Workspace 'Running it twice never overwrites an existing entry'
    $config = Join-Path $workspace 'claude_desktop_config.json'
    Set-Content -LiteralPath $config -Value $RealisticConfig -Encoding UTF8
    Register-ClaudeDesktopServer -Runner 'C:\first\run-mcp.ps1' -PowerShellPath $stub -ConfigPath $config | Out-Null
    $message = Register-ClaudeDesktopServer -Runner 'C:\second\run-mcp.ps1' -PowerShellPath $stub -ConfigPath $config
    $after = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json

    Assert-That 'the second run says it left the entry alone' ($message -match 'not overwritten')
    Assert-That 'the entry still points at the first launcher' (
        $after.mcpServers.'cronometer-personal'.args -contains 'C:\first\run-mcp.ps1')
    Assert-That 'the second run did not add another backup' (
        @(Get-ChildItem -LiteralPath $workspace -Filter '*.backup-*').Count -eq 1)

    # ---------------------------------------------------------------- 3
    $workspace = New-Workspace 'A machine with no Desktop configuration yet gets one'
    $config = Join-Path $workspace 'claude_desktop_config.json'
    Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $stub -ConfigPath $config | Out-Null
    $after = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json

    Assert-That 'the file is created' (Test-Path -LiteralPath $config -PathType Leaf)
    Assert-That 'it holds exactly one server' (
        (Get-PropertyName $after.mcpServers).Count -eq 1)
    Assert-That 'no backup is written when there was nothing to back up' (
        @(Get-ChildItem -LiteralPath $workspace -Filter '*.backup-*').Count -eq 0)

    # ---------------------------------------------------------------- 4
    $workspace = New-Workspace 'An empty configuration file is treated as empty, not broken'
    $config = Join-Path $workspace 'claude_desktop_config.json'
    Set-Content -LiteralPath $config -Value '' -Encoding UTF8
    Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $stub -ConfigPath $config | Out-Null
    Assert-That 'the server is registered' (
        (Get-PropertyName ((Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).mcpServers)) -contains 'cronometer-personal')

    # ---------------------------------------------------------------- 5
    $workspace = New-Workspace 'A configuration we do not understand is refused, not repaired'
    foreach ($case in @(
        @{ Name = 'a JSON array'; Content = '["not","an","object"]' },
        @{ Name = 'mcpServers holding a string'; Content = '{"mcpServers":"nonsense"}' }
    )) {
        $config = Join-Path $workspace ("bad-" + [guid]::NewGuid().ToString('N') + '.json')
        Set-Content -LiteralPath $config -Value $case.Content -Encoding UTF8
        $refused = $false
        try {
            Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $stub -ConfigPath $config | Out-Null
        } catch {
            $refused = $true
        }
        Assert-That ("$($case.Name) is refused") $refused
        Assert-That ("$($case.Name) is left exactly as it was") (
            (Get-Content -LiteralPath $config -Raw).Trim() -eq $case.Content)
    }

    # ---------------------------------------------------------------- 6
    $workspace = New-Workspace 'Claude Desktop not being installed is not an error'
    $missing = Join-Path (Join-Path $workspace 'no-such-directory') 'claude_desktop_config.json'
    $message = Register-ClaudeDesktopServer -Runner $runner -PowerShellPath $stub -ConfigPath $missing
    Assert-That 'it reports a skip rather than throwing' ($message -match 'not installed')
    Assert-That 'it creates nothing' (-not (Test-Path -LiteralPath $missing))

    # ---------------------------------------------------------------- 7
    $workspace = New-Workspace 'A Store PowerShell is registered by its alias, not its versioned folder'
    $storeBuild = 'C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe'
    $aliasDirectory = Join-Path (Join-Path $workspace 'Microsoft') 'WindowsApps'
    New-Item -ItemType Directory -Path $aliasDirectory -Force | Out-Null
    $alias = Join-Path $aliasDirectory 'pwsh.exe'
    Set-Content -LiteralPath $alias -Value '' -Encoding UTF8
    Assert-That 'the versioned Store path is swapped for the alias' (
        (Resolve-StablePowerShellPath -Source $storeBuild -LocalAppData $workspace) -eq $alias)
    $installed = 'C:\Program Files\PowerShell\7\pwsh.exe'
    Assert-That 'an ordinary install path is left alone' (
        (Resolve-StablePowerShellPath -Source $installed -LocalAppData $workspace) -eq $installed)
    Remove-Item -LiteralPath $alias -Force
    Assert-That 'with the alias turned off, the Store path is kept rather than inventing one' (
        (Resolve-StablePowerShellPath -Source $storeBuild -LocalAppData $workspace -WarningAction SilentlyContinue) -eq $storeBuild)

    # ---------------------------------------------------------------- 8
    $workspace = New-Workspace 'The remote connector URL comes from the Tailscale name, normalised once'
    Assert-That 'the trailing DNS dot is dropped and the path added' (
        (ConvertTo-PublicUrl 'My-PC.tail1234.ts.net.') -eq 'https://my-pc.tail1234.ts.net/mcp')
    $refusedUrl = $false
    try { ConvertTo-PublicUrl 'https://my-pc.tail1234.ts.net/mcp' | Out-Null } catch { $refusedUrl = $true }
    Assert-That 'a URL typed where a host name belongs is refused' $refusedUrl
    $status = '{ "Self": { "DNSName": "my-pc.tail1234.ts.net.", "HostName": "my-pc" } }'
    Assert-That 'the MagicDNS name is read from tailscale status' (
        (Get-TailscaleHostName -StatusJson $status) -eq 'my-pc.tail1234.ts.net')
    Assert-That 'a status without a DNS name gives nothing rather than guessing' (
        $null -eq (Get-TailscaleHostName -StatusJson '{ "Self": { "DNSName": "" } }'))
    Assert-That 'unreadable status gives nothing' ($null -eq (Get-TailscaleHostName -StatusJson 'not json'))

    $remote = New-RemoteConfiguration -PublicUrl 'https://my-pc.tail1234.ts.net/mcp' -OwnerPasswordHash 'scrypt$32768$8$1$s$k' -ListenPort 8787
    $roundTrip = $remote | ConvertTo-Json | ConvertFrom-Json
    Assert-That 'the saved configuration is what the launcher validates' (
        $roundTrip.version -eq 1 -and $roundTrip.listen_port -is [long] -and $roundTrip.owner_password_hash.StartsWith('scrypt$'))
    $refusedHash = $false
    try { New-RemoteConfiguration -PublicUrl 'https://x.ts.net/mcp' -OwnerPasswordHash 'hunter2' -ListenPort 8787 | Out-Null } catch { $refusedHash = $true }
    Assert-That 'a plaintext password is never saved in place of the hash' $refusedHash

    # ---------------------------------------------------------------- 9
    $workspace = New-Workspace 'The launcher accepts only the two transports it knows'
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-mcp.ps1') -Transport bogus *> $null
    Assert-That 'an unknown transport is refused before anything is read' ($LASTEXITCODE -ne 0)
} finally {
    Write-Host ""
    if ($script:Failures -eq 0) {
        Write-Host "$($script:Checks) checks passed."
    } else {
        Write-Host "$($script:Failures) of $($script:Checks) checks FAILED."
    }
}

exit ([int]($script:Failures -gt 0))
