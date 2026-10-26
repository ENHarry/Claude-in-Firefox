# Self-signs the extension through Mozilla's AMO "unlisted" flow and drops a
# permanently-installable .xpi in dist/.
#
# Prerequisites:
#   1) npm install          (from this directory, once)
#   2) amo-credentials.json filled in with your AMO API key/secret
#      -> get them at https://addons.mozilla.org/developers/addon/api/key/
#
# AMO rejects a version number it has already signed, so bump "version" in
# extension/manifest.json before every re-sign.

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$CredPath   = Join-Path $ScriptDir "amo-credentials.json"
$SourceDir  = Join-Path $ScriptDir "extension"
$ArtifactsDir = Join-Path $ScriptDir "dist"
$WebExt     = Join-Path $ScriptDir "node_modules\.bin\web-ext.cmd"

if (-not (Test-Path $WebExt)) {
  Write-Error "web-ext is not installed. Run 'npm install' in $ScriptDir first."
}

if (-not (Test-Path $CredPath)) {
  Write-Error "Missing $CredPath. Copy amo-credentials.example.json to amo-credentials.json and fill in your AMO API key and secret."
}

$Cred = Get-Content $CredPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Cred.apiKey) -or $Cred.apiKey -like "user:*REPLACE*") {
  Write-Error "amo-credentials.json still has the placeholder apiKey. Paste your real JWT issuer from https://addons.mozilla.org/developers/addon/api/key/"
}
if ([string]::IsNullOrWhiteSpace($Cred.apiSecret) -or $Cred.apiSecret -like "*REPLACE*") {
  Write-Error "amo-credentials.json still has the placeholder apiSecret."
}

$Manifest = Get-Content (Join-Path $SourceDir "manifest.json") -Raw | ConvertFrom-Json
$Version  = $Manifest.version
$ExtId    = $Manifest.browser_specific_settings.gecko.id

# AMO rejects add-on names containing Mozilla trademarks. Catch it here rather
# than after a multi-minute upload round trip.
if ($Manifest.name -match "(?i)firefox|mozilla") {
  Write-Error "Add-on name '$($Manifest.name)' contains a Mozilla trademark (Firefox/Mozilla). AMO will reject it. Rename 'name' in extension\manifest.json -- the gecko id can stay as it is."
}

Write-Host "Signing $ExtId version $Version (unlisted channel)..."
Write-Host "This uploads to Mozilla for automated validation and can take a few minutes."
Write-Host ""

& $WebExt sign `
  --source-dir="$SourceDir" `
  --artifacts-dir="$ArtifactsDir" `
  --channel=unlisted `
  --api-key="$($Cred.apiKey)" `
  --api-secret="$($Cred.apiSecret)"

$ExitCode = $LASTEXITCODE

if ($ExitCode -ne 0) {
  Write-Host ""
  Write-Host "Signing failed (exit $ExitCode)." -ForegroundColor Red
  Write-Host "If the error mentions a duplicate or already-existing version, bump"
  Write-Host "'version' in extension\manifest.json and run this again -- AMO will not"
  Write-Host "re-sign a version number it has already issued."
  exit $ExitCode
}

Write-Host ""
Write-Host "Signed .xpi written to: $ArtifactsDir" -ForegroundColor Green
Get-ChildItem $ArtifactsDir -Filter *.xpi -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5 Name, Length, LastWriteTime | Format-Table -AutoSize

Write-Host "To install permanently:"
Write-Host "  Firefox -> about:addons -> gear icon -> Install Add-on From File... -> pick the .xpi"
