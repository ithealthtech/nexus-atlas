<#
  Opens the built app with made-up data (--preview), walks through its pages with UI Automation, and takes a
  screenshot of each, so a change to how it looks can be seen without installing it. Along the way it checks that
  the forms save (a contact, an asset, documents) and lists what it found; a failed check is a warning, not a
  failed build. CI runs it after building, on its own machine; the pictures are uploaded with the build.

    apps/windows/Take-Screenshots.ps1 [-App path\to\AtlasForWindows.exe] [-Output folder]
#>
param(
  [string]$App = (Join-Path $PSScriptRoot 'dist\app\AtlasForWindows.exe'),
  [string]$Output = (Join-Path $PSScriptRoot 'dist\screenshots'),
  # tools/AccessibilityScan, built: each page is checked with Axe.Windows, and any problem fails the run.
  [string]$Scanner = (Join-Path $PSScriptRoot 'dist\scanner\AccessibilityScan.exe')
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  // A real left click where the pointer is, the way a person's click arrives (not an automation call).
  public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
}
'@

New-Item -ItemType Directory -Force -Path $Output | Out-Null
# CI machines start at 1024 x 768, too small to see the app at its usual size (1180 x 780). Windows Server can change it.
if ($env:GITHUB_ACTIONS -and (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
  try { Set-DisplayResolution -Width 1920 -Height 1080 -Force; Start-Sleep -Seconds 2 } catch { Write-Warning "Couldn't change the screen size: $($_.Exception.Message)" }
}
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
    try { $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
    catch { Check $false "pressed $what ($($_.Exception.Message))"; return }
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
    # The pointer off the window, so no tooltip from the last click shows in the picture.
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    [Win]::SetCursorPos($r.Right + 40, $r.Bottom + 40) | Out-Null
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

  Check (Shows 'Coming due') 'Home shows what is coming due'
  Check (Shows 'Good *') 'Home greets you and says how much is due'
  # Accessibility: what Axe.Windows (Accessibility Insights) finds on a page, collected for the end.
  $script:a11y = @()
  # A made-up client whose name ends in "Group": its heading in a list is a group, and the checker reads the word.
  $madeUpNames = @('NameExcludesControlType:Harbor Dental Group', 'NameExcludesLocalizedControlType:Harbor Dental Group')
  function Scan([string]$name) {
    if (-not (Test-Path $Scanner)) { return }
    $lines = @(& $Scanner $p.Id $name @madeUpNames 2>&1 | ForEach-Object { "$_" })
    $lines | ForEach-Object { Write-Host "  a11y  $_" }
    if ($LASTEXITCODE -ne 0) { $script:a11y += $lines | Where-Object { $_ -notmatch 'accessibility problem\(s\)\.$' } }
  }

  Shot '01-home'
  Scan 'home'

  # Real mouse clicks, quickly, across the sections and into a row: the right list shows and the app keeps up.
  function MouseClick($element, $what) {
    if (-not $element) { Check $false "found $what to click"; return }
    $r = $element.Current.BoundingRectangle
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    [Win]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  }
  function SectionItem($name) { All $CT::ListItem | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 }
  foreach ($name in 'Passwords', 'Assets', 'Documents', 'Clients', 'Passwords', 'Assets') {
    MouseClick (SectionItem $name) "the $name section"
    Start-Sleep -Milliseconds 150
  }
  Start-Sleep -Seconds 3
  $p.Refresh()
  Check $p.Responding 'the app keeps up with quick clicks'
  Check ((Title) -eq 'Assets') 'after quick clicks, the last section clicked is showing'
  Check (Shows 'HDG-DC-01') 'the Assets list shows assets'
  Check (-not (Shows 'Core switch enable')) 'the Assets list shows no passwords from an earlier section'
  MouseClick (All $CT::ListItem | Where-Object { $_.Current.Name -like 'HDG-DC-01*' } | Select-Object -First 1) 'the HDG-DC-01 row'
  Start-Sleep -Seconds 2
  Check ((Title) -eq 'HDG-DC-01') 'clicking a row with the mouse opens it'
  MouseClick (ById 'BackButton') 'Back'
  Start-Sleep -Seconds 2
  Check ((Title) -eq 'Assets') 'Back with the mouse returns to the list'
  Check (-not (Shows 'Core switch enable')) 'going back shows the same list, not an earlier one'
  Shot '01b-after-quick-clicks'

  Open 'Clients'
  Check (Shows 'Next 30 days') 'the Clients page shows its table'
  Check (Shows '*expiring*') 'a client shows what is coming due'
  Shot '02-clients'
  Scan 'clients'
  Open 'Harbor Dental Group*'
  Check ((Title) -eq 'Harbor Dental Group') 'a client opens on its overview'
  Shot '02-client-overview'
  Scan 'client overview'

  # A contact: add one, then see it on the overview.
  Press (Named $CT::Button 'Add contact') 'Add contact'
  Fill 'Name' 'Sam Ortiz'; Fill 'Title' 'Front desk'; Fill 'Email' 'sam@harbordental.demo'
  Shot '03-contact-form'
  Scan 'contact form'
  Press (ById 'SaveButton') 'the contact form''s save button'
  Check ((Title) -eq 'Harbor Dental Group' -and (Shows 'Sam Ortiz*')) 'a new contact shows on the overview'
  Check (Shows '*sam@harbordental.demo*') 'the contact''s email shows'

  # Each list, as a table.
  Open 'Passwords'
  Check (Shows 'Strength') 'the Passwords list shows its columns'
  Check (Shows 'In 2 breaches') 'a breached password is flagged'
  Shot '03b-passwords'
  Scan 'passwords'
  Open 'Documents'
  Check (Shows 'Needs review') 'a document shows its status'
  Shot '03c-documents'

  # An asset: the form is drawn from its type.
  Open 'Assets'
  Check (Shows 'Warranty expires') 'an asset shows what is coming due'
  Shot '03d-assets'
  Press (ById 'NewButton') 'New asset'
  Choose 'Client' 'Harbor Dental Group'; Choose 'Asset layout' 'Configurations'
  Fill 'Name' 'HDG-SW-01'; Choose 'Type *' 'Switch'
  Shot '04-asset-form'
  Scan 'asset form'
  Press (ById 'SaveButton') 'the asset form''s save button'
  Check ((Title) -eq 'HDG-SW-01') 'a new asset saves and opens'
  Shot '05-asset'
  $connect = ById 'ConnectButton'
  Check ($connect -and $connect.Current.Name -eq 'Find in ScreenConnect') 'a device without a ScreenConnect session ID offers to find it'

  # Under an item: what it's linked to and its files; a password's earlier versions; a code counting down.
  Open 'Assets'; Open 'HDG-FW-01*'
  Check ((Shows 'Related') -and (Shows 'Firewall reboot procedure*')) 'an asset shows what it is linked to'
  Shot '05b-related'
  Scan 'asset'
  Open 'Passwords'; Open 'HDG-FW-01 admin*'
  Check ((Shows 'Earlier passwords') -and (Shows 'Files') -and (Shows 'HDG-FW-01 backup.conf')) 'a password shows its earlier versions and files'
  Shot '05c-history'
  Scan 'password'
  Open 'Passwords'; Open 'Microsoft 365 global admin*'
  Press (Named $CT::Button 'Show the current code') 'Show the current code'
  Check (Shows '*changes in*s') 'a one-time code counts down while shown'
  # The archived list, and an archived item opens with Restore.
  Open 'Passwords'
  $archived = ById 'ArchivedToggle'
  if ($archived) { $archived.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle(); Start-Sleep -Seconds 2 }
  Check (Shows 'Old VPN admin') 'the archived list shows archived passwords'
  Open 'Old VPN admin*'
  # A button that is hidden is not in the automation tree at all.
  Check ([bool](ById 'RestoreButton') -and -not (ById 'EditHereButton')) 'an archived password opens with Restore and without Edit'
  Shot '05d-archived'
  Open 'Passwords'

  # A document: open it, change its text, save.
  Open 'Documents'; Open 'Firewall reboot procedure*'
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

  # A document with every kind of formatting: headings, a quote, a checklist, code, a table, and lists.
  Press (ById 'BackButton') 'Back'
  Open 'New client onboarding checklist*'
  Check ((Title) -eq 'New client onboarding checklist') 'a knowledge base document opens'
  Check ((Shows 'First visit') -and (Shows '*Standard VLANs*')) 'a document shows its headings as text'
  Check ([bool](Named $CT::Button 'Copy code')) 'a code block has a copy button'
  Shot '06b-document-formatting'
  Scan 'document'
  $scroller = $win.FindAll($T, (Cond $AE::IsScrollPatternAvailableProperty $true)) |
    Where-Object { $_.GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern).Current.VerticallyScrollable } | Select-Object -Last 1
  if ($scroller) {
    $scroller.GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern).SetScrollPercent(-1, 100); Start-Sleep -Milliseconds 800
    Shot '06c-document-formatting-end'
  }
  else { Check $false 'found the page''s scroll area' }

  # A new document in the knowledge base.
  Press (ById 'BackButton') 'Back'
  Press (ById 'NewButton') 'New document'
  Fill 'Title' 'Printer setup'
  Fill 'Document text' "# Printers`r`r1. Add the queue`r2. Print a test page"
  Press (ById 'SaveButton') 'the new document''s save button'
  Check ((Title) -eq 'Printer setup' -and (Shows '*Print a test page*')) 'a new document saves'
  Shot '09-new-document'

  # Settings, from the account menu; then the dark theme on a few pages.
  Press (ById 'AccountButton') 'the account menu'
  Press (Named $CT::MenuItem 'Settings') 'Settings in the account menu'
  Check ((Title) -eq 'Settings') 'Settings opens from the account menu'
  Check ([bool](Named $CT::ComboBox 'Search shortcut')) 'Settings offers a choice of search shortcut'
  Shot '10-settings'
  Scan 'settings'
  Choose 'Theme' 'Dark'
  Shot '10b-settings-dark'
  Scan 'settings, dark'
  Open 'Home'
  Shot '11-home-dark'
  Open 'Passwords'
  Shot '11b-passwords-dark'
  Scan 'passwords, dark'
  Open 'Documents'; Open 'New client onboarding checklist*'
  Shot '11c-document-dark'

  $p.Refresh()
  Check $p.Responding 'the app is still responding'
}
finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
if ($failed.Count -gt 0) { Write-Warning ("$($failed.Count) check(s) failed: " + ($failed -join '; ')) } else { Write-Host 'All checks passed.' }
if ($a11y.Count -gt 0) {
  $a11y | ForEach-Object { Write-Host "::error::$_" }
  throw "Axe.Windows found $($a11y.Count) accessibility problem(s); they're listed above."
}
if (Test-Path $Scanner) { Write-Host 'No accessibility problems found.' }
