#Requires -Version 7
<#
.SYNOPSIS
    Start (or restart) the dedicated Chrome instance that DSH browser automation attaches to.

.DESCRIPTION
    DSH's Browser Harness provider attaches over CDP. Two Windows-specific traps make
    the obvious approaches fail:

      1. `chrome.exe --remote-debugging-port=9222` against the DEFAULT profile silently
         does nothing when Chrome is already running: the new process hands the request
         to the existing one, and the default profile does not expose remote debugging
         to this flag. The port never opens.

      2. With the default profile, Chrome 153 gates CDP behind an interactive
         "要允许远程调试吗？" consent dialog. That dialog is a separate top-level HWND,
         so CUA's consent matcher (which walks the approved main-window tree) cannot see
         it, and `browser_prepare` fails with `browser_target_refused` forever.

    Both are avoided by running a DEDICATED profile with the flag applied at startup.
    This instance does not prompt for consent, and `http://127.0.0.1:9222/json/version`
    returns 200 (it 404s on the consent-gated default profile).

    The dedicated profile keeps its own cookies and logins, separate from the user's
    daily browsing, and can be deleted wholesale to reset it.
#>
[CmdletBinding()]
param(
    # Override the default dedicated profile location.
    [string] $ProfileDir = (Join-Path $env:LOCALAPPDATA 'ChromeAgentProfile'),

    # Remote debugging port. BU_CDP_URL must match this.
    [int] $Port = 9222,

    # Skip the confirm prompt that normally guards terminating running Chrome processes.
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

$chrome = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe'
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    throw 'chrome.exe not found in any known location.'
}

# Fast path: this script must be safe to run repeatedly, because automation and
# agents call it before every task. If a dedicated instance is already serving
# CDP on the requested port, restarting it would needlessly close the user's
# tabs and logins in the agent profile. Reuse it instead.
$alreadyServing = $false
try {
    $probe = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    # Only adopt the port when the responder really is a browser we can drive.
    if ($probe.webSocketDebuggerUrl) { $alreadyServing = $true }
} catch {
    # Nothing listening yet; fall through to a normal start.
}

if ($alreadyServing -and -not $Force) {
    Write-Host "CDP already available on port $Port ($($probe.Browser)); reusing it."
    $version = $probe
}
else {

# Chrome allows only one process per --user-data-dir, so the previous instance must exit
# before the new one can own the port. Close the dedicated profile only: never touch the
# user's daily Chrome, which uses a different profile directory.
$owned = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*$ProfileDir*" }

if ($owned) {
    if (-not $Force) {
        Write-Host "Closing $($owned.Count) process(es) using the dedicated profile..."
    }
    $owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# Browser Harness serializes daemon startup with a spawnlock next to its pid/port
# files. A crashed or killed spawener leaves that lock behind, and every later
# spawn then blocks on it: the MCP server still starts and still lists its tools,
# but the first real call fails with a permission/access error on the port file.
# A HEALTHY daemon has bu-default.pid + bu-default.port and NO spawnlock, so a
# lone spawnlock means the previous daemon died badly and must be cleared.
#
# This is the failure that silently removed every browser tool from a Session
# with no obvious symptom, so it is repaired here rather than left to be
# rediscovered.
$runtime = Join-Path $env:USERPROFILE '.config\browser-harness\runtime'
$spawnlock = Join-Path $runtime 'bu-default.spawnlock'
$pidFile = Join-Path $runtime 'bu-default.pid'
$portFile = Join-Path $runtime 'bu-default.port'

if (Test-Path $spawnlock) {
    $daemonPid = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { '' }
    $alive = $false
    if ($daemonPid -match '^\d+$') {
        $alive = [bool](Get-Process -Id ([int]$daemonPid) -ErrorAction SilentlyContinue)
    }

    if ($alive -and (Test-Path $portFile)) {
        Write-Host "Browser Harness daemon $daemonPid is alive; leaving its spawnlock alone."
    } else {
        Write-Host "Clearing stale Browser Harness spawnlock (daemon is not running)." -ForegroundColor Yellow
        Remove-Item $spawnlock -Force -ErrorAction SilentlyContinue
        # pid/port files describe a daemon that no longer exists; drop them too so
        # the next spawn cannot read a dead daemon's address.
        Remove-Item $pidFile, $portFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

Write-Host "Starting dedicated Chrome..."
Write-Host "  profile: $ProfileDir"
Write-Host "  port:    $Port"

Start-Process $chrome -ArgumentList @(
    "--remote-debugging-port=$Port"
    "--user-data-dir=$ProfileDir"
    '--no-first-run'
    '--no-default-browser-check'
    'about:blank'
)

# The port opening is the only meaningful readiness check. Poll rather than sleep a fixed
# interval so a fast start is not penalised and a slow one is not misreported.
$deadline = (Get-Date).AddSeconds(30)
$ready = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
        $ready = $true
        break
    } catch {
        # Port not up yet; keep polling until the deadline.
    }
}

if (-not $ready) {
    throw "CDP endpoint did not open on port $Port within 30s. Check chrome://policy (remote debugging can be blocked by policy)."
}

}  # end of the start-a-new-instance branch

Write-Host ''
Write-Host "Ready: $($version.Browser) (protocol $($version.'Protocol-Version'))" -ForegroundColor Green
Write-Host "  ws: $($version.webSocketDebuggerUrl)"

# An open port only proves Chrome is listening. The capability that actually
# matters is whether Browser Harness can drive it, and that has failed before
# while the port looked perfectly healthy. Probe the real path via the
# `browser-harness` CLI (not the MCP wrapper, which needs a live session).
$cli = Join-Path $env:USERPROFILE '.local\bin\browser-harness.exe'
if (Test-Path $cli) {
    $prev = $env:BU_CDP_URL
    $env:BU_CDP_URL = "http://127.0.0.1:$Port"
    try {
        $probe = 'print(page_info())' | & $cli 2>&1
        if ($LASTEXITCODE -eq 0 -and ($probe -join '') -match '\{.*url.*\}') {
            Write-Host ''
            Write-Host 'Browser Harness can drive this browser.' -ForegroundColor Green
            Write-Host "  $($probe -join '')"
        } else {
            Write-Host ''
            Write-Host "Browser Harness probe did not return page data:" -ForegroundColor Yellow
            Write-Host "  $($probe -join '')"
        }
    } finally {
        $env:BU_CDP_URL = $prev
    }
} else {
    Write-Host ''
    Write-Host "browser-harness.exe not found at $cli; skipped the end-to-end probe." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'The DSH profile already sets cdpUrl to this port, so nothing else is required.'
Write-Host 'In DSH, open a NEW session - the browser provider does not adopt sessions'
Write-Host 'that were already active when it mounted.'
