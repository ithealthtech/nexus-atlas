<#
.SYNOPSIS
  Builds Atlas for Windows and its setup program.

.DESCRIPTION
  Publishes the app as plain files that need nothing else installed (no MSIX, no .NET or Windows App SDK on the
  computer), then wraps them in a per-user setup program with Inno Setup 6. CI runs this on every pull request and
  the release workflow runs it for every release, so what is tested is what ships.

  Needs the .NET 10 SDK and Inno Setup 6 (choco install innosetup).

.PARAMETER Output
  Where the results go: app\ (the published files), AtlasForWindowsSetup.exe, and its .sha256.
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
if (Test-Path $app) {
  Remove-Item -Recurse -Force $app
}

dotnet publish (Join-Path $PSScriptRoot 'src\Atlas.Windows') -c Release -r win-x64 -p:Platform=x64 `
  -p:WindowsPackageType=None -p:WindowsAppSDKSelfContained=true --self-contained true -o $app
if ($LASTEXITCODE -ne 0) {
  throw 'dotnet publish failed.'
}

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $iscc) {
  throw 'Inno Setup 6 was not found. Install it with: choco install innosetup'
}
& $iscc "/DAppVersion=$version" "/DSourceDir=$app" "/DOutputDir=$Output" (Join-Path $PSScriptRoot 'installer\AtlasForWindows.iss')
if ($LASTEXITCODE -ne 0) {
  throw 'The setup program failed to build.'
}

$setup = Join-Path $Output 'AtlasForWindowsSetup.exe'
"$((Get-FileHash $setup -Algorithm SHA256).Hash.ToLower())  AtlasForWindowsSetup.exe" | Set-Content "$setup.sha256"
Write-Host "Built Atlas for Windows $version`: $setup"
