# Builds iaqs and runs the unit test suite.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "build.ps1") -BuildType Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $root "build\iaqs_tests.exe")
exit $LASTEXITCODE
