<#
  Opens the built app with made-up data (--preview), walks through its pages with UI Automation, and takes a
  screenshot of each, so a change to how it looks can be seen without installing it. Along the way it checks that
  the forms save (a contact, an asset, documents) and lists what it found; a failed check is a warning, not a
  failed build. CI runs it after building, on its own machine; the pictures are uploaded with the build.

    apps/windows/Take-Screenshots.ps1 [-App path\to\AtlasForWindows.exe] [-Output folder]
#>
param(
  [string]$App = (Join-Path $PSScriptRoot 'dist\app\AtlasForWindows.exe'),
  [string]$Output = (Join-Path $PSScriptRoot 'dist\screenshots')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$p = Start-Process $App -ArgumentList '--preview' -PassThru
$failed = @()
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $p.Refresh() }
  if ($p.MainWindowHandle -eq 0) { throw 'The app did not open its window in a minute.' }
  $hwnd = $p.MainWindowHandle
  Start-Sleep -Seconds 4

  $win = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $T = [Windows.Automation.TreeScope]::Descendants
  $AE = [Windows.Automation.AutomationElement]
  $CT = [Windows.Automation.ControlType]
  function Cond($prop, $value) { New-Object Windows.Automation.PropertyCondition($prop, $value) }
  function All($type) { $win.FindAll($T, (Cond $AE::ControlTypeProperty $type)) }
  function ById($id) { $win.FindFirst($T, (Cond $AE::AutomationIdProperty $id)) }
  function Named($type, $name) { All $type | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 }
  function Check([bool]$ok, [string]$what) {
    if ($ok) { Write-Host "  ok    $what" } else { Write-Warning "check failed: $what"; $script:failed += $what }
  }
  function Press($element, $what) {
    if (-not $element) { Check $false "found $what"; return }
    $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1800
  }
  function Open($name) { Press (All $CT::ListItem | Where-Object { $_.Current.Name -like $name } | Select-Object -First 1) "list item '$name'" }
  function Fill($header, $text) {
    $box = Named $CT::Edit $header
    if (-not $box) { Check $false "found field '$header'"; return }
    $box.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($text)
  }
  function Choose($combo, $option) {
    $box = Named $CT::ComboBox $combo
    if (-not $box) { Check $false "found list '$combo'"; return }
    $box.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 800
    $item = Named $CT::ListItem $option
    if (-not $item) { Check $false "found '$option' in '$combo'"; return }
    $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 800
  }
  function Title { $t = ById 'PageTitle'; if ($t) { $t.Current.Name } else { '' } }
  function Shows($pattern) { [bool](All $CT::Text | Where-Object { $_.Current.Name -like $pattern } | Select-Object -First 1) }
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

  Shot '01-home'

  Open 'Clients'
  Check (Shows 'Next 30 days') 'the Clients page shows its table'
  Check (Shows '*expiring*') 'a client shows what is coming due'
  Shot '02-clients'
  Open 'Harbor Dental Group*'
  Check ((Title) -eq 'Harbor Dental Group') 'a client opens on its overview'
  Shot '02-client-overview'

  # A contact: add one, then see it on the overview.
  Press (Named $CT::Button 'Add contact') 'Add contact'
  Fill 'Name' 'Sam Ortiz'; Fill 'Title' 'Front desk'; Fill 'Email' 'sam@harbordental.demo'
  Shot '03-contact-form'
  Press (ById 'SaveButton') 'the contact form''s save button'
  Check ((Title) -eq 'Harbor Dental Group' -and (Shows 'Sam Ortiz*')) 'a new contact shows on the overview'
  Check (Shows '*sam@harbordental.demo*') 'the contact''s email shows'

  # Each list, as a table.
  Open 'Passwords'
  Check (Shows 'Strength') 'the Passwords list shows its columns'
  Check (Shows 'In 2 breaches') 'a breached password is flagged'
  Shot '03b-passwords'
  Open 'Documents'
  Check (Shows 'Needs review') 'a document shows its status'
  Shot '03c-documents'

  # An asset: the form is drawn from its type.
  Open 'Assets'
  Check (Shows 'Warranty expires') 'an asset shows what is coming due'
  Shot '03d-assets'
  Press (ById 'NewButton') 'New asset'
  Choose 'Client' 'Harbor Dental Group'; Choose 'Type' 'Configurations'
  Fill 'Name' 'HDG-SW-01'; Choose 'Type *' 'Switch'
  Shot '04-asset-form'
  Press (ById 'SaveButton') 'the asset form''s save button'
  Check ((Title) -eq 'HDG-SW-01') 'a new asset saves and opens'
  Shot '05-asset'

  # A document: open it, change its text, save.
  Open 'Documents'; Open 'Firewall reboot procedure, Document'
  Check ((Title) -eq 'Firewall reboot procedure') 'a document opens'
  Shot '06-document'
  Press (ById 'EditHereButton') 'Edit here on a document'
  $text = Named $CT::Edit 'Document text'
  $value = if ($text) { $text.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } else { '' }
  Check ($value -like '*## Steps*' -and $value -like '*- `[ `] Tell the office manager*') 'the document opens as editable text'
  Shot '07-document-editor'
  if ($text) { $text.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($value + "`r`r**Checked by the screenshot run.**") }
  Press (ById 'SaveButton') 'the document form''s save button'
  Check ((Title) -eq 'Firewall reboot procedure' -and (Shows '*Checked by the screenshot run.*')) 'an edited document saves and shows the new text'
  Shot '08-document-saved'

  # A new document in the knowledge base.
  Press (ById 'BackButton') 'Back'
  Press (ById 'NewButton') 'New document'
  Fill 'Title' 'Printer setup'
  Fill 'Document text' "# Printers`r`r1. Add the queue`r2. Print a test page"
  Press (ById 'SaveButton') 'the new document''s save button'
  Check ((Title) -eq 'Printer setup' -and (Shows '*Print a test page*')) 'a new document saves'
  Shot '09-new-document'

  $p.Refresh()
  Check $p.Responding 'the app is still responding'
}
finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
if ($failed.Count -gt 0) { Write-Warning ("$($failed.Count) check(s) failed: " + ($failed -join '; ')) } else { Write-Host 'All checks passed.' }
