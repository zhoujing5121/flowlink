[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$PiSystemProxy,
    [string]$PiProxy
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

# Native PowerShell pipelines decode output with Console.OutputEncoding, not
# necessarily with the active code page. Set both for this terminal session.
try {
    & chcp.com 65001 | Out-Null
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
} catch {
    Write-Verbose 'The current host does not expose a configurable Windows console.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronCli = Join-Path $projectRoot 'node_modules\electron\cli.js'

Push-Location $projectRoot
try {
    & node (Join-Path $projectRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $electronArgs = @($electronCli, '.')
    if ($Dev) {
        $electronArgs += '--inspect=9229'
    }
    if ($PiSystemProxy) {
        $electronArgs += '--pi-system-proxy'
    }
    if ($PiProxy) {
        $electronArgs += "--pi-proxy=$PiProxy"
    }
    & node @electronArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
