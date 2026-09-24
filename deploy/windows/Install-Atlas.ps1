<#
.SYNOPSIS
  Installs (or upgrades) MSP Atlas as a Windows service.

.DESCRIPTION
  Run from an elevated PowerShell prompt in the Atlas source folder, after "npm ci" and "npm run build".
  The script:
    - checks Node.js 22+;
    - creates the data folder (default C:\ProgramData\MSP Atlas) readable only by Administrators and SYSTEM;
    - creates the master key file on first install (never overwrites it) and reminds you to back it up;
    - writes atlas.env with your settings (kept on upgrade unless you pass new values);
    - downloads WinSW 2.12.0, checks its SHA-256, and registers the "MSPAtlas" service (automatic start,
      restart on failure) running as LocalSystem (the only account the locked-down data folder admits);
    - starts the service and waits for /readyz.

  Put Atlas behind HTTPS: IIS with URL Rewrite + ARR, or Caddy for Windows, forwarding to http://127.0.0.1:4318.

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -PublicUrl https://atlas.example.com -DatabaseUrl "postgres://atlas:secret@localhost:5432/atlas"

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$PublicUrl,
  [string]$DatabaseUrl,
  [string]$DataDir = (Join-Path $env:ProgramData 'MSP Atlas'),
  [string]$BackupDir,
  [int]$Port = 4318,
  [string]$ServiceName = 'MSPAtlas',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ServiceDir = Join-Path $DataDir 'service'
$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"
$EnvFile = Join-Path $DataDir 'atlas.env'
$KeyFile = Join-Path $DataDir 'atlas-master.key'

function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell prompt (Run as administrator).'
  }
}

function Protect-Folder([string]$Path) {
  # Only Administrators and SYSTEM (the service account) can read the data folder, key, and backups.
  & icacls $Path /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not set permissions on $Path." }
}

Assert-Admin

if ($Uninstall) {
  if (Test-Path $ServiceExe) {
    & $ServiceExe stop | Out-Null
    & $ServiceExe uninstall
  }
  Write-Host "Service removed. Data, key, and backups are still in $DataDir; delete them yourself if you mean to."
  return
}

# Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or later is required: https://nodejs.org' }
$major = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($major -lt 22) { throw "Node.js 22 or later is required (found $major)." }
if (-not (Test-Path (Join-Path $AppDir 'apps\server\dist\index.js'))) {
  throw "Build Atlas first: run 'npm ci' and 'npm run build' in $AppDir."
}

# Data folder and master key
New-Item -ItemType Directory -Force -Path $DataDir, $ServiceDir | Out-Null
Protect-Folder $DataDir
if (-not (Test-Path $KeyFile)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Set-Content -Path $KeyFile -Value $key -NoNewline -Encoding ascii
  Write-Warning "A new master key was created at $KeyFile. Copy it somewhere safe and separate from your backups now: without it, passwords and backups can't be decrypted."
}

# Settings
$existing = @{}
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $existing[$Matches[1]] = $Matches[2] }
}
if ($PublicUrl) { $existing['PUBLIC_URL'] = $PublicUrl }
if ($DatabaseUrl) { $existing['DATABASE_URL'] = $DatabaseUrl }
if ($BackupDir) { $existing['ATLAS_BACKUP_DIR'] = $BackupDir }
foreach ($required in 'PUBLIC_URL', 'DATABASE_URL') {
  if (-not $existing[$required]) { throw "Pass -$(if ($required -eq 'PUBLIC_URL') {'PublicUrl'} else {'DatabaseUrl'}) on the first install." }
}
$existing['NODE_ENV'] = 'production'
$existing['HOST'] = '127.0.0.1'
$existing['PORT'] = "$Port"
$existing['TRUST_PROXY'] = 'true'
$existing['ATLAS_DATA_DIR'] = $DataDir
$existing['ATLAS_MASTER_KEY_FILE'] = $KeyFile
($existing.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) | Set-Content -Path $EnvFile -Encoding utf8

# Service wrapper
if (-not (Test-Path $ServiceExe) -or (Get-FileHash $ServiceExe -Algorithm SHA256).Hash -ne $WinSwSha256) {
  Invoke-WebRequest -Uri $WinSwUrl -OutFile $ServiceExe -UseBasicParsing
  $hash = (Get-FileHash $ServiceExe -Algorithm SHA256).Hash
  if ($hash -ne $WinSwSha256) {
    Remove-Item $ServiceExe -Force
    throw "The downloaded service wrapper failed its checksum ($hash). Nothing was installed."
  }
}
$envXml = ($existing.GetEnumerator() | Sort-Object Name | ForEach-Object {
    "  <env name=`"$($_.Name)`" value=`"$([Security.SecurityElement]::Escape($_.Value))`" />"
  }) -join "`n"
@"
<service>
  <id>$ServiceName</id>
  <name>MSP Atlas</name>
  <description>MSP Atlas documentation and password manager.</description>
  <executable>$($node.Source)</executable>
  <arguments>"$AppDir\apps\server\dist\index.js"</arguments>
  <workingdirectory>$AppDir</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <logpath>$DataDir\logs</logpath>
$envXml
</service>
"@ | Set-Content -Path (Join-Path $ServiceDir "$ServiceName.xml") -Encoding utf8

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  & $ServiceExe stop | Out-Null
  & $ServiceExe refresh
} else {
  & $ServiceExe install
}
& $ServiceExe start

for ($i = 0; $i -lt 60; $i++) {
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
      Write-Host "MSP Atlas is running. Open $($existing['PUBLIC_URL'])."
      Write-Host "First install: the setup code is in $DataDir\logs\$ServiceName.out.log"
      return
    }
  } catch { Start-Sleep -Seconds 2 }
}
throw "Atlas didn't become ready. Check $DataDir\logs for errors."
