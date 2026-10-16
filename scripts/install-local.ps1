# Installs the freshly built Post over the copy your Start menu, taskbar and desktop shortcuts open,
# then reopens it. Run via `npm run install-local` (which builds first) or on its own after a build.
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$setup = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\Post_*_x64-setup.exe" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw "No installer found. Run 'npm run tauri build' first." }
$installed = Join-Path $env:LOCALAPPDATA "Post\post.exe"

# The installer can't replace post.exe while it's running.
$running = Get-Process post -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installed }
if ($running) {
  Write-Host "Closing Post..."
  $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  Get-Process post -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installed } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

Write-Host "Installing $($setup.Name) (built $($setup.LastWriteTime))..."
Start-Process $setup.FullName -ArgumentList "/S" -Wait

$exe = Get-Item $installed -ErrorAction SilentlyContinue
if (-not $exe -or $exe.LastWriteTime -lt $setup.LastWriteTime.AddMinutes(-5)) {
  throw "Install didn't replace $installed (still dated $($exe.LastWriteTime))."
}
Write-Host "Installed: $installed ($($exe.LastWriteTime))"
# Started through WMI rather than as our child: when this script runs inside a packaged app's shell
# (the Claude desktop app, say), a child would inherit its AppData redirection and open a stale or
# empty copy of the mailbox instead of the real one.
$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$installed`"" }
