<#
.SYNOPSIS
  Builds Atlas for Windows and its setup program.

.DESCRIPTION
  Publishes the app as plain files that need nothing else installed (no MSIX, no .NET or Windows App SDK on the
  computer), for x64 and for ARM64, then wraps both in one per-user setup program with Inno Setup 6. Setup installs
  the build that matches the PC, so the same download (and the in-app update) works everywhere. CI runs this on every pull request and
  the release workflow runs it for every release, so what is tested is what ships.

  Needs the .NET 10 SDK and Inno Setup 6 (choco install innosetup).

.PARAMETER Output
  Where the results go: app\ and app-arm64\ (the published files), AtlasForWindowsSetup.exe, and its .sha256.
#>
param(
  [string]$Output = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'

$version = "$(([xml](Get-Content (Join-Path $PSScriptRoot 'Directory.Build.props'))).Project.PropertyGroup.Version)".Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Directory.Build.props has no usable <Version> (found '$version')."
}

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Output = (Resolve-Path $Output).Path
$app = Join-Path $Output 'app'
$appArm64 = Join-Path $Output 'app-arm64'

# The machine a Windows program is built for, from its PE header: 0x8664 is x64, 0xAA64 is ARM64.
function Machine([string]$exe) {
  $bytes = [IO.File]::ReadAllBytes($exe)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  [BitConverter]::ToUInt16($bytes, $pe + 4)
}

foreach ($build in @(@{ Rid = 'win-x64'; Platform = 'x64'; Folder = $app; Machine = 0x8664 },
                     @{ Rid = 'win-arm64'; Platform = 'ARM64'; Folder = $appArm64; Machine = 0xAA64 })) {
  if (Test-Path $build.Folder) {
    Remove-Item -Recurse -Force $build.Folder
  }
  dotnet publish (Join-Path $PSScriptRoot 'src\Atlas.Windows') -c Release -r $build.Rid -p:Platform=$($build.Platform) `
    -p:WindowsPackageType=None -p:WindowsAppSDKSelfContained=true --self-contained true -o $build.Folder
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed for $($build.Rid)."
  }
  # Nothing can run the ARM64 build on an x64 machine, so at least check it is one.
  $found = Machine (Join-Path $build.Folder 'AtlasForWindows.exe')
  if ($found -ne $build.Machine) {
    throw ("AtlasForWindows.exe for {0} is built for machine 0x{1:X4}, not 0x{2:X4}." -f $build.Rid, $found, $build.Machine)
  }
}

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $iscc) {
  throw 'Inno Setup 6 was not found. Install it with: choco install innosetup'
}
& $iscc "/DAppVersion=$version" "/DSourceDir=$app" "/DSourceDirArm64=$appArm64" "/DOutputDir=$Output" (Join-Path $PSScriptRoot 'installer\AtlasForWindows.iss')
if ($LASTEXITCODE -ne 0) {
  throw 'The setup program failed to build.'
}

$setup = Join-Path $Output 'AtlasForWindowsSetup.exe'
"$((Get-FileHash $setup -Algorithm SHA256).Hash.ToLower())  AtlasForWindowsSetup.exe" | Set-Content "$setup.sha256"
Write-Host "Built Atlas for Windows $version`: $setup"
