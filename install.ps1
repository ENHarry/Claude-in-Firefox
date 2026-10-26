# Registers the native messaging host with Firefox on Windows.
# Run this once, after `cd host; npm install`, from a PowerShell prompt.
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is not on your PATH. Install Node.js 18+ first."
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Join-Path $ScriptDir "host"
$Wrapper = Join-Path $HostDir "host-wrapper.cmd"
$HostName = "com.anthropic.claude_in_firefox"
$ManifestPath = Join-Path $HostDir "$HostName.json"

@"
@echo off
node "$HostDir\native-host.js"
"@ | Set-Content -Path $Wrapper -Encoding ASCII

$ManifestObj = [ordered]@{
  name               = $HostName
  description        = "Claude in Firefox native messaging host"
  path               = $Wrapper
  type               = "stdio"
  allowed_extensions = @("claude-in-firefox@local.connector")
}
# NOTE: must be UTF-8 *without* a BOM. Windows PowerShell 5.1's
# `Set-Content -Encoding UTF8` writes a BOM, and Firefox's native messaging
# manifest parser rejects the file outright if one is present -- connectNative()
# then fails with no visible error. Write the bytes explicitly instead.
$ManifestJson = $ManifestObj | ConvertTo-Json
[IO.File]::WriteAllText($ManifestPath, $ManifestJson, (New-Object System.Text.UTF8Encoding($false)))

New-Item -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName" -Name "(Default)" -Value $ManifestPath

Write-Host "Registered native messaging host manifest at:"
Write-Host "  $ManifestPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1) cd host; npm install   (if you haven't already)"
Write-Host "  2) In Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> select extension\manifest.json"
Write-Host "  3) claude mcp add claude-in-firefox -- node `"$HostDir\mcp-server.js`""
Write-Host ""
Write-Host "Note: 'Load Temporary Add-on' clears when Firefox restarts. See README.md for a persistent option."
