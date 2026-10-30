$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") { throw "Run this script on native Windows." }
if ($env:BROWSEFRIEND_TEST_WINE) { throw "Clear BROWSEFRIEND_TEST_WINE to run the complete native Windows suite." }

Push-Location (Join-Path $PSScriptRoot "../..")
try {
  # Requires Go and Node; x64 race tests also require a compatible MinGW-w64 C compiler.
  & npm.cmd run verify
  if ($LASTEXITCODE -ne 0) { throw "Windows verification failed (exit $LASTEXITCODE)." }
  Write-Host "Native Windows verification passed. Manual Chrome browser testing is separate."
} finally {
  Pop-Location
}
