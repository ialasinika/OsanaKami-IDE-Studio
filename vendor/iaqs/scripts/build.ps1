# Builds iaqs with MinGW-w64 + CMake.
# NOTE: the Ninja generator hangs in this environment ("Detecting CXX compiler
# ABI info" never completes), so MinGW Makefiles is used instead.
param(
  [string]$BuildType = "Release",
  [switch]$Clean
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$mingw = "C:\mingw64\mingw64\bin"
if (Test-Path (Join-Path $mingw "g++.exe")) {
  $env:PATH = "$mingw;$env:PATH"
}

Push-Location $root
try {
  if ($Clean -and (Test-Path "build")) {
    Remove-Item -Recurse -Force "build"
  }
  cmake -S . -B build -G "MinGW Makefiles" "-DCMAKE_BUILD_TYPE=$BuildType"
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
  cmake --build build --parallel
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
  Write-Host "build ok: $root\build\iaqs.exe"
} finally {
  Pop-Location
}
