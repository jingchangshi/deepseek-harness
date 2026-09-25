#Requires -Version 7
<#
.SYNOPSIS
    Check whether DSH browser automation is ready, end to end.

.DESCRIPTION
    Browser tools silently disappear from a Session when any one link in the chain
    is broken, and DSH reports no error - the Session simply has no `mcp__browser__*`
    tools. This script checks every link and names the one that is broken.

    The chain:
      1. The DSH web profile mounts the browser-use provider (cordis.patch.yml).
      2. A dedicated Chrome instance is serving CDP on the configured port.
      3. The Browser Harness daemon is alive and attached to that browser.
      4. The Session was created AFTER the provider mounted.

    Step 4 cannot be checked from outside DSH. A Session's tool list is fixed when
    it is created, and the provider never adopts an already-active Session, so the
    only reliable check is to ask the model for a `mcp__browser__*` tool. This
    script verifies steps 1-3 and states that requirement explicitly.
#>
[CmdletBinding()]
param(
    [int] $Port = 9222
)

$ErrorActionPreference = 'Continue'
$ok = 0
$fail = 0

function Pass($msg) { Write-Host "  [ok]   $msg" -ForegroundColor Green; $script:ok++ }
function Fail($msg, $hint) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
    if ($hint) { Write-Host "         -> $hint" -ForegroundColor Yellow }
    $script:fail++
}

Write-Host "DSH browser automation check"
Write-Host ''

# --- 1. the provider package is resolvable by the loader ---------------------
# This was the real bug, and it failed SILENTLY: the entry reported only
# "failed to import", the rest of DSH booted normally, and every Session simply
# had no browser tools. DSH resolves plugin names through the tsconfig.base.json
# path aliases, so a browser-use package missing from that list imports fine in
# isolation yet dies inside the loader.
$repoRoot = Split-Path -Parent $PSScriptRoot
$tsconfig = Join-Path $repoRoot 'tsconfig.base.json'
$alias = '@deepseek-ai/dsh-experimental-browser-use-browser-harness-mcp'
if (Test-Path $tsconfig) {
    if ((Get-Content $tsconfig -Raw) -match [regex]::Escape($alias)) {
        Pass "tsconfig.base.json maps $alias"
    } else {
        Fail "$alias has no tsconfig.base.json path alias" `
            "Without it the loader cannot import the provider and every Session silently loses its browser tools. Add the alias pointing at packages/experimental/browser-use-browser-harness-mcp/src/index.ts."
    }
} else {
    Fail "tsconfig.base.json not found at $tsconfig" 'Run this script from the DSH checkout.'
}

# --- 2. profile wires the provider ------------------------------------------
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (Test-Path $patch) {
    $text = Get-Content $patch -Raw
    if ($text -match 'browser-use-browser-harness-mcp') {
        if ($text -match "cdpUrl:\s*'http://127\.0\.0\.1:$Port'") {
            Pass "profile mounts the browser provider with cdpUrl on port $Port"
        } else {
            Fail "profile mounts the provider but cdpUrl does not match port $Port" `
                "Expected `cdpUrl: 'http://127.0.0.1:$Port'` in $patch"
        }
    } else {
        Fail 'profile does not mount the browser-use provider' "Add the browser-use entries to $patch"
    }
} else {
    Fail "profile patch not found: $patch" 'The web profile has no user patch layer.'
}

# --- 2. effective web composition -------------------------------------------
# Raw profile patches are only one layer. Inspect the same composed tree used by
# DSH so home-level and command-line overlays cannot silently change readiness.
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
    try {
        $dump = (& $dsh.Source --profile web --dump-config 2>&1 | Out-String)
        $harnessRows = ([regex]::Matches($dump, 'browser-use-browser-harness-mcp')).Count
        $browserUseRows = ([regex]::Matches($dump, 'id:[32;1m\s*browser-use')).Count
        $playwrightRows = ([regex]::Matches($dump, 'browser-use-playwright|browser-use-browser-use')).Count
        if ($harnessRows -eq 1 -and $browserUseRows -eq 1 -and $playwrightRows -eq 0) {
            if ($dump -match [regex]::Escape("http://127.0.0.1:$Port")) {
                Pass 'effective web composition has exactly one Browser Harness provider and matching CDP endpoint'
            } else {
                Fail 'effective Browser Harness provider endpoint does not match the requested CDP port' 'Inspect dsh --profile web --dump-config and the active patch layers.'
            }
        } else {
            Fail 'effective web composition does not contain exactly one intended Browser Harness provider' 'Remove competing browser providers and inspect dsh --profile web --dump-config.'
        }
    } catch {
        Fail 'could not inspect effective web composition' 'Run dsh --profile web --dump-config manually and repair the profile composition.'
    }
} else {
    Fail 'dsh executable not found on PATH' 'Build/install the DSH CLI before running browser readiness.'
}

# --- 2. dedicated Chrome serving CDP ----------------------------------------
$cdp = $null
try {
    $cdp = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    Pass "CDP endpoint answering on $Port ($($cdp.Browser))"
} catch {
    Fail "no CDP endpoint on port $Port" 'Run scripts/chrome-agent.ps1 to start the dedicated instance.'
}

# Confirm the listener is the DEDICATED profile. The default profile's CDP is
# gated behind an interactive consent dialog that automation cannot satisfy, so
# a browser answering on the port is not by itself proof of a usable instance.
if ($cdp) {
    $dedicated = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -match "remote-debugging-port=$Port" -and $_.CommandLine -match 'ChromeAgentProfile' }
    if ($dedicated) {
        Pass "listener belongs to the dedicated profile ($($dedicated.Count) processes)"
    } else {
        Fail 'the process on this port is not the dedicated agent profile' `
            'A default-profile browser needs interactive consent. Run scripts/chrome-agent.ps1.'
    }
}

# --- 3. Browser Harness daemon attached -------------------------------------
$cli = Join-Path $env:USERPROFILE '.local\bin\browser-harness.exe'
if (Test-Path $cli) {
    $prev = $env:BU_CDP_URL
    $env:BU_CDP_URL = "http://127.0.0.1:$Port"
    try {
        $probe = 'print(page_info())' | & $cli 2>&1
        if ($LASTEXITCODE -eq 0 -and ($probe -join '') -match 'url') {
            Pass "Browser Harness can drive the browser"
            Write-Host "         $($probe -join '')"
        } else {
            Fail 'Browser Harness could not read a page' ($probe -join ' ')
        }
    } finally {
        $env:BU_CDP_URL = $prev
    }
} else {
    Fail "browser-harness.exe not found at $cli" 'Install with: uv tool install browser-harness[mcp]'
}

# Stale spawnlock: the daemon serializes startup with a lock file, and a crashed
# spawn leaves it behind so every later spawn fails on the port file. A healthy
# daemon has pid+port files and NO lock.
$runtime = Join-Path $env:USERPROFILE '.config\browser-harness\runtime'
$lock = Join-Path $runtime 'bu-default.spawnlock'
if (Test-Path $lock) {
    $pidFile = Join-Path $runtime 'bu-default.pid'
    $alive = $false
    if (Test-Path $pidFile) {
        $dpid = (Get-Content $pidFile -Raw).Trim()
        if ($dpid -match '^\d+$') { $alive = [bool](Get-Process -Id ([int]$dpid) -ErrorAction SilentlyContinue) }
    }
    if ($alive) { Pass "daemon pid $dpid alive (spawnlock present and expected)" }
    else { Fail 'stale spawnlock blocks new daemon spawns' 'Run scripts/chrome-agent.ps1 to clear it.' }
} else {
    Pass 'no stale spawnlock'
}

Write-Host ''
if ($fail -eq 0) {
    Write-Host "Environment ready ($ok checks passed)." -ForegroundColor Green
    Write-Host ''
    Write-Host 'IMPORTANT - the one step this script cannot verify:' -ForegroundColor Cyan
    Write-Host '  The DSH Session must have been created AFTER the provider mounted.'
    Write-Host '  A Session created earlier has no browser tools, and reloading the'
    Write-Host '  provider does not adopt it. Open a NEW session, then ask the model'
    Write-Host '  for any mcp__browser__* tool. If it reports the tool is missing,'
    Write-Host '  the session is too old - open another one.'
    exit 0
} else {
    Write-Host "$fail check(s) failed." -ForegroundColor Red
    exit 1
}
