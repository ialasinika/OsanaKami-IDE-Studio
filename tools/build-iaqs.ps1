# Builds the project's version store (iaqs/) into build-iaqs/.
#
# The binary is never committed: build-iaqs/ is ignored, and the installer
# payload picks the executable up from there.  cmake, g++ and mingw32-make must
# be on PATH; on Windows that means putting MinGW-w64's bin first (see
# AGENTS.md, and iaqs/README.md for why the generator is "MinGW
# Makefiles" rather than Ninja).

param(
  [string]$BuildType = "Release",
  [switch]$Strip,
  [switch]$Tests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "iaqs"
$build = Join-Path $root "build-iaqs"

foreach ($tool in @("cmake", "g++", "mingw32-make")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not on PATH -- put MinGW-w64's bin directory first (AGENTS.md)"
  }
}

Push-Location $root
try {
  cmake -S $source -B $build -G "MinGW Makefiles" "-DCMAKE_BUILD_TYPE=$BuildType"
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
  cmake --build $build --parallel
  if ($LASTEXITCODE -ne 0) { throw "build failed" }

  $exe = Join-Path $build "iaqs.exe"
  if ($Strip) {
    # Not `$strip`: PowerShell variable names are case-insensitive, so that would
    # be the switch parameter and joining a path into it would fail.
    $stripExe = Join-Path (Split-Path (Get-Command g++).Source -Parent) "strip.exe"
    & $stripExe -s $exe
    if ($LASTEXITCODE -ne 0) { throw "strip failed" }
  }

  $info = Get-Item $exe
  Write-Host ("build ok: {0} ({1:N0} bytes)" -f $exe, $info.Length)

  if ($Tests) {
    # The harness creates random directories under TEMP. A child process under
    # this machine's file sandbox may only write inside the workspace, so the
    # run points TEMP at a scratch directory; without this, temp-dir tests fail
    # with "cannot create directories: Permission denied".
    $testTemp = Join-Path $build "test-temp"
    New-Item -ItemType Directory -Force -Path $testTemp | Out-Null
    $savedTemp = $env:TEMP
    $savedTmp = $env:TMP
    try {
      $env:TEMP = $testTemp
      $env:TMP = $testTemp
      & (Join-Path $build "iaqs_tests.exe")
      $code = $LASTEXITCODE
    } finally {
      $env:TEMP = $savedTemp
      $env:TMP = $savedTmp
      Remove-Item -Recurse -Force $testTemp -ErrorAction SilentlyContinue
    }
    exit $code
  }
} finally {
  Pop-Location
}
