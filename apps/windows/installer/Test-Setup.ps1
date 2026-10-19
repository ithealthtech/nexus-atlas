<#
.SYNOPSIS
  Runs the built app and its setup program for real, on the build machine: the app's self-test, a first install,
  an upgrade over a running copy, opening it again while it is hidden or minimized, and an uninstall.

.DESCRIPTION
  Everything here is per-user and is undone by the uninstall at the end. It exists because compiling the app says
  nothing about whether its window loads, whether setup can close a running copy, or whether uninstalling cleans up.

.PARAMETER Output
  The folder build-installer.ps1 wrote to.
#>
param(
  [string]$Output = (Join-Path (Split-Path $PSScriptRoot) 'dist')
)
$ErrorActionPreference = 'Stop'

$setup = Join-Path $Output 'AtlasForWindowsSetup.exe'
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Atlas for Windows'
$exe = Join-Path $installed 'AtlasForWindows.exe'
$data = Join-Path $env:LOCALAPPDATA 'Atlas for Windows'
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Atlas for Windows.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'Atlas for Windows'

function Step($text) { Write-Host "`n== $text" }
function Running { [bool](Get-Process AtlasForWindows -ErrorAction SilentlyContinue) }
function StartupCommand { (Get-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue }
function WaitUntil([scriptblock]$condition, [int]$seconds, [string]$failure) {
  for ($i = 0; $i -lt $seconds * 4; $i++) {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 250
  }
  throw $failure
}
function Install([string]$log) {
  $p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$log" -PassThru -Wait
  if ($p.ExitCode -ne 0) {
    if (Test-Path $log) { Get-Content $log -Tail 60 }
    throw "Setup exited with code $($p.ExitCode)."
  }
}

Step 'Self-test: the window and the tray icon load'
$report = Join-Path $env:TEMP 'AtlasForWindows-selftest.txt'
Remove-Item $report -ErrorAction SilentlyContinue
$p = Start-Process (Join-Path $Output 'app\AtlasForWindows.exe') -ArgumentList '--self-test' -PassThru
if (-not $p.WaitForExit(120000)) {
  $p.Kill()
  throw 'The app did not finish its self-test in two minutes.'
}
if (Test-Path $report) { Get-Content $report }
if ($p.ExitCode -ne 0) { throw "The self-test failed (exit code $($p.ExitCode))." }

Step 'First install'
$log = Join-Path $env:TEMP 'atlas-setup-1.log'
Install $log
if (-not (Test-Path $exe)) { throw "Setup did not install $exe." }
if (-not (Test-Path $shortcut)) { throw 'Setup did not add the Start menu shortcut.' }
if ((StartupCommand) -ne "`"$exe`" --startup") { throw "Start with Windows is not set as expected: $(StartupCommand)" }
if (Running) { throw 'A silent install should not start the app.' }

Step 'Upgrade over a running copy, with Start with Windows turned off in the app'
Remove-ItemProperty $runKey -Name $runValue
Start-Process $exe -ArgumentList '--startup'
WaitUntil { Running } 30 'The installed app did not start.'
# Long enough for it to finish starting and take its place as the running copy.
Start-Sleep -Seconds 8
if (-not (Running)) { throw 'The installed app started and then stopped.' }
$log = Join-Path $env:TEMP 'atlas-setup-2.log'
Install $log
if (Running) { throw 'Setup left the old copy running.' }
if (-not (Select-String -Path $log -SimpleMatch 'closed when asked' -Quiet)) {
  Get-Content $log | Select-String 'Atlas for Windows'
  throw 'The running copy did not quit when setup asked it to (it had to be ended).'
}
if (StartupCommand) { throw 'An upgrade turned Start with Windows back on.' }
if (-not (Test-Path $exe)) { throw 'The upgrade removed the app.' }

Step 'Opening the app again brings back a window hidden in the tray, or minimized'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AppWin {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  // Every top-level window the process owns, as "handle class 'title' visible".
  public static List<string> Describe(int pid) {
    var all = new List<string>();
    EnumWindows((h, _) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid) {
        var name = new StringBuilder(256); GetClassName(h, name, 256);
        var text = new StringBuilder(256); GetWindowText(h, text, 256);
        all.Add(h + " " + name + " '" + text + "' " + (IsWindowVisible(h) ? "visible" : "hidden"));
      }
      return true;
    }, IntPtr.Zero);
    return all;
  }
  // The app's main window, visible or not: the one titled "Atlas" (the tray's menu has a window of its own).
  public static IntPtr Main(int pid) {
    var found = IntPtr.Zero;
    EnumWindows((h, _) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      var text = new StringBuilder(256); GetWindowText(h, text, 256);
      if (text.ToString() == "Atlas") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
function MainWindow { $p = Get-Process AtlasForWindows -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { [AppWin]::Main($p.Id) } else { [IntPtr]::Zero } }
function ShowWindows { Get-Process AtlasForWindows -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "Windows of process $($_.Id):"; [AppWin]::Describe($_.Id) | ForEach-Object { Write-Host "  $_" } } }
Start-Process $exe
try { WaitUntil { (MainWindow) -ne [IntPtr]::Zero -and [AppWin]::IsWindowVisible((MainWindow)) } 30 'The app did not open its window.' }
catch { ShowWindows; throw }
Start-Sleep -Seconds 6
$window = MainWindow
# Closing the window hides it; the app stays in the tray.
[AppWin]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
WaitUntil { -not [AppWin]::IsWindowVisible($window) } 15 'Closing the window did not hide it.'
if (-not (Running)) { throw 'Closing the window quit the app instead of hiding it in the tray.' }
Start-Process $exe
try { WaitUntil { [AppWin]::IsWindowVisible($window) } 20 'Opening the app again did not bring back its window from the tray.' }
catch { ShowWindows; throw }
if ([AppWin]::GetForegroundWindow() -eq $window) { Write-Host 'The window came to the front.' }
else { Write-Warning 'The window came back but is not in front (this build machine may not allow it).' }
if (@(Get-Process AtlasForWindows).Count -ne 1) { throw 'Opening the app again left two copies running.' }
# Minimized: opening it again restores it.
[AppWin]::ShowWindow($window, 6) | Out-Null
WaitUntil { [AppWin]::IsIconic($window) } 10 'The window did not minimize.'
Start-Process $exe
WaitUntil { -not [AppWin]::IsIconic($window) } 20 'Opening the app again did not restore its minimized window.'
Start-Process $exe -ArgumentList '--quit' -Wait
WaitUntil { -not (Running) } 30 'The app did not quit when asked.'

Step 'Uninstall'
New-Item -ItemType Directory -Force -Path $data | Out-Null
Set-Content (Join-Path $data 'settings.json') '{}'
New-ItemProperty $runKey -Name $runValue -Value "`"$exe`" --startup" -Force | Out-Null
Start-Process $exe -ArgumentList '--startup'
WaitUntil { Running } 30 'The installed app did not start again.'
Start-Sleep -Seconds 8
Start-Process (Join-Path $installed 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'
# The uninstaller hands over to a copy of itself, so wait for the result rather than the process.
WaitUntil { -not (Test-Path $exe) } 90 'Uninstalling left the app in place.'
WaitUntil { -not (Test-Path $data) } 30 'Uninstalling left the saved settings and session behind.'
if (Running) { throw 'Uninstalling left the app running.' }
if (StartupCommand) { throw 'Uninstalling left Start with Windows behind.' }
if (Test-Path $shortcut) { throw 'Uninstalling left the Start menu shortcut.' }

Write-Host "`nSetup works: self-test, install, upgrade over a running copy, and uninstall."
