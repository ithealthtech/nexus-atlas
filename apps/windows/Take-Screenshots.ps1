<#
  Opens the built app with made-up data (--preview) and takes screenshots of its window, so a change to how it looks
  can be seen without installing it: the starred list with a password, an asset, a document, and a search.
  CI runs it after building; the pictures are uploaded with the build.

    apps/windows/Take-Screenshots.ps1 [-App path\to\AtlasForWindows.exe] [-Output folder]
#>
param(
  [string]$App = (Join-Path $PSScriptRoot 'dist\app\AtlasForWindows.exe'),
  [string]$Output = (Join-Path $PSScriptRoot 'dist\screenshots')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$p = Start-Process $App -ArgumentList '--preview' -PassThru
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $p.Refresh() }
  if ($p.MainWindowHandle -eq 0) { throw 'The app did not open its window in a minute.' }
  $hwnd = $p.MainWindowHandle
  Start-Sleep -Seconds 4

  function Shot([string]$name) {
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 900
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $Output "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bitmap.Dispose()
    Write-Host "Saved $name.png ($w x $h)"
  }
  function Keys([string]$keys) {
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    Start-Sleep -Milliseconds 1200
  }

  # Favorites opens first, with its first item (a password) chosen.
  Shot 'favorites-password'
  # The starred asset, then the starred document: down the list from the search box.
  Keys '{DOWN}'; Keys '{DOWN}'
  Shot 'favorites-asset'
  Keys '{DOWN}'; Keys '{DOWN}'
  Shot 'favorites-document'
  # Show a password, then search.
  Keys '^f'; Keys 'hdg'
  Shot 'search'
  Keys '{ESC}'
}
finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
