@echo off
@if /i not "%~1"=="uninstall" (
  @"__PHINS_EXECUTABLE__" %*
  @exit /b
)
@setlocal
@set "PHINS_UNINSTALL_LAUNCHER=%~f0"
@set "PHINS_UNINSTALL_RECEIPT=%TEMP%\phins-uninstall-%RANDOM%-%RANDOM%.ps1"
@(
  @"__PHINS_EXECUTABLE__" %*
  @if errorlevel 1 exit /b 1
  @if not exist "%PHINS_UNINSTALL_RECEIPT%" exit /b 0
  @"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { & ([scriptblock]::Create([IO.File]::ReadAllText($env:PHINS_UNINSTALL_RECEIPT))); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
  @if errorlevel 1 exit /b 1
  @del /q "%~f0" & exit /b 0
)
