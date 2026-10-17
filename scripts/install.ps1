<#
.SYNOPSIS
    Link dsh-plugin-telegram into a DeepSeek Harness profile.

.DESCRIPTION
    Registers this plugin directory as a `link:` dependency of a DSH profile and
    selects it as a bundle, using the `dsh` command shipped inside DSH Desktop.

    The script is idempotent: running it twice performs the same package
    operation again, which pnpm resolves to the same state. It only ever runs the
    bundled CLI; it never edits profile files by hand and never writes outside
    the plugin directory.

    Quit DSH Desktop before running this. The bundled CLI locks the profile's
    package.json, and a running Desktop can hold that lock.

.PARAMETER Profile
    The DSH profile to install into. Defaults to `desktop`.

.PARAMETER DryRun
    Print the command that would run, without executing it. Exits 0.

.PARAMETER DshCli
    Explicit path to the `dsh.cmd` launcher. Defaults to the Desktop
    installation under $env:LOCALAPPDATA.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\install.ps1 -DryRun

.EXAMPLE
    pwsh -NoProfile -File .\scripts\install.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\install.ps1 -Profile web
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string] $Profile = 'desktop',

    [switch] $DryRun,

    [string] $DshCli
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- helpers ---------------------------------------------------------------

function Write-Step {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([string] $Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Problem {
    param([string] $Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
}

# --- locate the plugin directory (relative to this script) -----------------

$PluginDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ManifestPath = Join-Path $PluginDir 'package.json'

Write-Step "Plugin directory: $PluginDir"

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    Write-Problem "package.json not found at $ManifestPath."
    Write-Note 'Run this script from inside the dsh-plugin-telegram package (scripts/install.ps1).'
    exit 1
}

# Read the package name and confirm the bundle patch exists. Both matter: the
# CLI only selects a bundle whose manifest declares dsh.bundle.patch, and a
# wrong name would install something unrelated.
try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
} catch {
    Write-Problem "Could not parse $ManifestPath : $($_.Exception.Message)"
    exit 1
}

if ($manifest.PSObject.Properties.Name -notcontains 'name' -or [string]::IsNullOrWhiteSpace($manifest.name)) {
    Write-Problem "package.json has no 'name' field; cannot install it."
    exit 1
}
$PackageName = [string] $manifest.name

$bundlePatch = $null
if ($manifest.PSObject.Properties.Name -contains 'dsh' -and
    $null -ne $manifest.dsh -and
    $manifest.dsh.PSObject.Properties.Name -contains 'bundle' -and
    $null -ne $manifest.dsh.bundle -and
    $manifest.dsh.bundle.PSObject.Properties.Name -contains 'patch') {
    $bundlePatch = [string] $manifest.dsh.bundle.patch
}

if ([string]::IsNullOrWhiteSpace($bundlePatch)) {
    Write-Problem "package.json does not declare dsh.bundle.patch, so the profile would gain no plugin row."
    Write-Note 'Without a bundle patch the CLI installs a plain dependency and the bot never mounts.'
    exit 1
}

$bundlePatchPath = Join-Path $PluginDir $bundlePatch
if (-not (Test-Path -LiteralPath $bundlePatchPath -PathType Leaf)) {
    Write-Problem "dsh.bundle.patch points at '$bundlePatch', which does not exist in the package."
    exit 1
}

Write-Note "Package: $PackageName"
Write-Note "Bundle patch: $bundlePatch"

# --- locate the bundled dsh CLI -------------------------------------------

$suppliedCli = -not [string]::IsNullOrWhiteSpace($DshCli)

if (-not $suppliedCli) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    $DshCli = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($DshCli) -or -not (Test-Path -LiteralPath $DshCli -PathType Leaf)) {
    Write-Problem 'Could not find the bundled dsh CLI.'
    if ($suppliedCli) {
        Write-Note 'The path given with -DshCli does not exist:'
        Write-Note "  $DshCli"
    } else {
        Write-Note 'Looked for:'
        Write-Note "  $env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
        Write-Note 'Pass an explicit path with -DshCli <path>, or install the plugin manually (see README).'
    }
    exit 1
}

$DshCli = (Resolve-Path -LiteralPath $DshCli).Path
Write-Note "CLI: $DshCli"

# --- build the command -----------------------------------------------------

# A `link:` spec installs the directory in place. Forward slashes keep the spec
# valid regardless of PowerShell quoting.
$linkSpec = 'link:' + ($PluginDir -replace '\\', '/')
$cliArgs = @('plugin', '--profile', $Profile, 'add', $linkSpec)

Write-Step 'Package operation'
Write-Host ''
Write-Host ('  & "{0}" {1}' -f $DshCli, (($cliArgs | ForEach-Object {
    if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
}) -join ' ')) -ForegroundColor Yellow
Write-Host ''

if ($DryRun) {
    Write-Step 'Dry run: nothing was executed.'
    Write-Note 'Re-run without -DryRun to perform the install.'
    exit 0
}

# --- run it ---------------------------------------------------------------

try {
    & $DshCli @cliArgs
    $exitCode = $LASTEXITCODE
} catch {
    Write-Problem "Failed to start the dsh CLI: $($_.Exception.Message)"
    exit 1
}

if ($exitCode -ne 0) {
    Write-Problem "The package operation failed with exit code $exitCode."
    Write-Note 'Common causes:'
    Write-Note '  - DSH Desktop is running and holds the profile lock: quit it and retry.'
    Write-Note '  - pnpm is missing from PATH.'
    Write-Note "  - The profile '$Profile' has not been initialized yet."
    Write-Note 'The CLI prints its own diagnostic (and a log path) above this message.'
    exit $exitCode
}

# --- verify and print next steps -----------------------------------------

Write-Step "Installed. Verifying that the profile lists $PackageName ..."

$listed = $false
try {
    $verifyOutput = & $DshCli plugin --profile $Profile list --depth 0 2>&1
    if ($LASTEXITCODE -eq 0) {
        $listed = ($verifyOutput | Out-String) -match [regex]::Escape($PackageName)
    }
} catch {
    $listed = $false
}

if ($listed) {
    Write-Note "Confirmed: $PackageName is a dependency of profile '$Profile'."
} else {
    Write-Host ''
    Write-Host "WARNING: could not confirm $PackageName in the profile's dependency list." -ForegroundColor Yellow
    Write-Note "Check manually with:"
    Write-Note ('  & "{0}" plugin --profile {1} list' -f $DshCli, $Profile)
}

Write-Host ''
Write-Step 'Next steps'
Write-Host ''
Write-Host '  1. Give the plugin a token. Add this row to the profile patch'
Write-Host "     (C:\Users\$env:USERNAME\.dsh\profiles\$Profile\cordis.patch.yml):"
Write-Host ''
Write-Host '       - insert:'
Write-Host '           - id: telegram-bot'
Write-Host "             name: $PackageName"
Write-Host '             config:'
Write-Host '               token: "123456789:AAH..."'
Write-Host '               allowedUsers: [123456789]'
Write-Host ''
Write-Host '     Or, instead of config:, export the token before starting DSH:'
Write-Host ''
Write-Host '       $env:DSH_TELEGRAM_BOT_TOKEN = "123456789:AAH..."'
Write-Host '       $env:DSH_TELEGRAM_ALLOWED_USERS = "123456789"'
Write-Host ''
Write-Host '     Define the row in one place only. The Loader keys entries by id, so a'
Write-Host '     second insert row with the same id silently replaces this one.'
Write-Host ''
Write-Host '  2. If api.telegram.org is blocked on your network, set the proxy as well:'
Write-Host ''
Write-Host '       proxy: "socks5://127.0.0.1:1080"'
Write-Host ''
Write-Host '     (or $env:DSH_TELEGRAM_PROXY). Without it the bot logs'
Write-Host '     "getMe failed" and stays off. See README.md for details.'
Write-Host ''
Write-Host '  3. Restart DSH. Startup should log:'
Write-Host ''
Write-Host '       telegram-bot: polling as @your_bot'
Write-Host ''
Write-Host '     Then open Telegram and send /start to the bot.'
Write-Host ''
Write-Note "Documentation: $(Join-Path $PluginDir 'README.md')"
exit 0
