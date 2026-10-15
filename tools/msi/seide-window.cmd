@echo off
rem seIDE window launcher -- installed by the MSI as seide-window.cmd.
rem
rem PREREQUISITE: Node 24 must be installed and on PATH.  The project never
rem bundles Node or Electron, so this shim just hands the request to "node".
rem It works from wherever the Start Menu shortcut starts it because %~dp0 is
rem the directory this .cmd itself lives in (the install directory, trailing
rem backslash included), never the caller's current directory.
rem
rem The workspace is the user's profile.  Board state is written by the shell
rem to %USERPROFILE%\.seide\ -- outside the install directory, so uninstalling
rem seIDE leaves the user's board exactly where it was.
node "%~dp0shell\main.mjs" serve --workspace "%USERPROFILE%"
