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
    - without -PublicUrl: serves Atlas over HTTPS at this server's own address, https://<LAN IP>:4318, with a
      certificate made for that address and trusted on this server, and allows that port through Windows Firewall
      on private and domain networks. Run it again with -PublicUrl once Atlas has a domain;
    - downloads WinSW 2.12.0, checks its SHA-256, and registers the "MSPAtlas" service (automatic start,
      restart on failure) running as LocalSystem (the only account the locked-down data folder admits);
    - starts the service and waits for /readyz.

  With -PublicUrl (a domain), Atlas listens only on 127.0.0.1:4318 and your HTTPS reverse proxy serves it: IIS
  with URL Rewrite + ARR, or Caddy for Windows, forwarding to http://127.0.0.1:4318 and keeping the Host header.
  The local certificate and firewall rule are removed.

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -DatabaseUrl "postgres://atlas:secret@localhost:5432/atlas"
  First install, reached at https://<this server's LAN IP>:4318.

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -PublicUrl https://atlas.example.com
  Later: Atlas has a domain, served by a reverse proxy.

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -LocalAddress auto
  Back to this server's own address after using a domain (or pass the address or a name to use, such as 192.168.1.20).

.EXAMPLE
  .\deploy\windows\Install-Atlas.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$PublicUrl,
  # Serve Atlas at this server's own address instead of a domain: an address or name to use, or "auto" for the
  # LAN address of the network adapter with the default route (what a first install without -PublicUrl does).
  [string]$LocalAddress,
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
$TlsDir = Join-Path $DataDir 'tls'
$PfxFile = Join-Path $TlsDir 'atlas-local.pfx'
# The certificate without its key, for other computers to trust: not secret, so it's beside the app.
$CerFile = Join-Path $AppDir 'atlas-local-certificate.cer'
$CertName = 'MSP Atlas (local address)'
$FirewallRule = 'MSP Atlas (HTTPS)'
# Node.js only speaks TLS 1.2 or later, and so does GitHub.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

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

# The IPv4 address of the adapter with the default route: the one other computers on the network use.
function Get-LanAddress {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' }
  $address = $addresses | Where-Object { $route -and $_.InterfaceIndex -eq $route.ifIndex } | Select-Object -First 1
  if (-not $address) { $address = $addresses | Select-Object -First 1 }
  if (-not $address) { throw "Couldn't find this server's network address. Pass -LocalAddress with its address or name." }
  $address.IPAddress
}

function Remove-LocalCertificates {
  foreach ($store in 'Root', 'My') {
    Get-ChildItem "Cert:\LocalMachine\$store" | Where-Object { $_.FriendlyName -eq $CertName } | ForEach-Object {
      # -DeleteKey only exists for a certificate path given directly, and only a certificate with its key has one.
      $path = "Cert:\LocalMachine\$store\$($_.Thumbprint)"
      if ($_.HasPrivateKey) { Remove-Item -LiteralPath $path -DeleteKey } else { Remove-Item -LiteralPath $path }
    }
  }
}

# A certificate for this server's own address, kept while it still covers the address and has a month left.
function Set-LocalCertificate([string]$Address, [hashtable]$Settings) {
  $isIp = [Net.IPAddress]::TryParse($Address, [ref]$null)
  $san = if ($isIp) { "IP Address=$Address" } else { "DNS Name=$Address" }
  $pass = $Settings['ATLAS_TLS_PFX_PASSPHRASE']
  if ((Test-Path $PfxFile) -and $pass) {
    try {
      $current = New-Object Security.Cryptography.X509Certificates.X509Certificate2($PfxFile, $pass)
      $names = ($current.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ', '
      if ($current.NotAfter -gt (Get-Date).AddDays(30) -and ($names -split ', ') -contains $san) { return }
    } catch { }
  }
  Remove-LocalCertificates
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pass = [Convert]::ToBase64String($bytes)
  $ext = if ($isIp) { "IPAddress=$Address" } else { "DNS=$Address" }
  $cert = New-SelfSignedCertificate -Subject "CN=MSP Atlas ($Address)" -FriendlyName $CertName `
    -TextExtension @("2.5.29.17={text}$ext", '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
    -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2) `
    -CertStoreLocation Cert:\LocalMachine\My
  New-Item -ItemType Directory -Force -Path $TlsDir | Out-Null
  Export-PfxCertificate -Cert $cert -FilePath $PfxFile -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null
  Export-Certificate -Cert $cert -FilePath $CerFile | Out-Null
  # Trusted on this server, so its own browser and this script's check don't warn; the key lives only in the .pfx.
  Import-Certificate -FilePath $CerFile -CertStoreLocation Cert:\LocalMachine\Root |
    ForEach-Object { $_.FriendlyName = $CertName }
  Remove-Item -LiteralPath "Cert:\LocalMachine\My\$($cert.Thumbprint)" -DeleteKey
  $Settings['ATLAS_TLS_PFX_FILE'] = $PfxFile
  $Settings['ATLAS_TLS_PFX_PASSPHRASE'] = $pass
}

function Test-AtlasReady([hashtable]$Settings) {
  $url = $Settings['PUBLIC_URL']
  try {
    if ($Settings['ATLAS_TLS_PFX_FILE']) {
      return (Invoke-WebRequest "$url/readyz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
    }
    # Behind a proxy: ask Atlas directly, addressed to its public name, as the proxy does.
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/readyz")
    $request.Host = ([uri]$url).Authority
    $request.Timeout = 2000
    $response = $request.GetResponse()
    try { return [int]$response.StatusCode -eq 200 } finally { $response.Close() }
  } catch { return $false }
}

Assert-Admin

if ($Uninstall) {
  if (Test-Path $ServiceExe) {
    & $ServiceExe stop | Out-Null
    & $ServiceExe uninstall
  }
  Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
  Remove-LocalCertificates
  Write-Host "Service removed. Data, key, and backups are still in $DataDir; delete them yourself if you mean to."
  return
}

# Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required. Install Node.js 24 LTS from https://nodejs.org' }
$major = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($major -lt 22) { throw "Node.js 22 or later is required (found $major). Install Node.js 24 LTS from https://nodejs.org" }
if ($major -eq 22) { Write-Warning 'Node.js 22 stops getting security fixes on 30 April 2027. Move to Node.js 24 LTS: see "Moving to Node.js 24" in docs/DEPLOYMENT.md.' }
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
if ($DatabaseUrl) { $existing['DATABASE_URL'] = $DatabaseUrl }
if ($BackupDir) { $existing['ATLAS_BACKUP_DIR'] = $BackupDir }
if (-not $existing['DATABASE_URL']) { throw 'Pass -DatabaseUrl on the first install.' }
if ($PublicUrl -and $PSBoundParameters.ContainsKey('LocalAddress')) { throw 'Pass -PublicUrl or -LocalAddress, not both.' }
if ($PublicUrl) {
  if ($PublicUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d{1,5})?/?$') {
    throw '-PublicUrl must be an https:// address with a domain, such as https://atlas.yourmsp.com.'
  }
  $existing['PUBLIC_URL'] = $PublicUrl.TrimEnd('/')
  $existing.Remove('ATLAS_TLS_PFX_FILE')
  $existing.Remove('ATLAS_TLS_PFX_PASSPHRASE')
}
# This server's own address until Atlas has a domain: on a first install, when asked, or when it was before (the
# address is looked up again each time, in case it changed).
$local = $PSBoundParameters.ContainsKey('LocalAddress') -or -not $existing['PUBLIC_URL'] -or $existing['ATLAS_TLS_PFX_FILE']
$existing['NODE_ENV'] = 'production'
$existing['PORT'] = "$Port"
if ($local) {
  $address = if ($LocalAddress -and $LocalAddress -ne 'auto') { $LocalAddress } else { Get-LanAddress }
  if ($address -notmatch '^[A-Za-z0-9.-]{1,253}$') { throw '-LocalAddress must be an IPv4 address or a name, such as 192.168.1.20.' }
  $existing['PUBLIC_URL'] = "https://$($address):$Port"
  Set-LocalCertificate $address $existing
  $existing['HOST'] = '0.0.0.0'
  $existing['TRUST_PROXY'] = 'false'
  if (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -DisplayName $FirewallRule -LocalPort $Port
  } else {
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Protocol TCP -LocalPort $Port `
      -Action Allow -Profile Domain, Private | Out-Null
  }
} else {
  $existing['HOST'] = '127.0.0.1'
  $existing['TRUST_PROXY'] = 'true'
  Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
  Remove-LocalCertificates
  Remove-Item $PfxFile, $CerFile -ErrorAction SilentlyContinue
}
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
  # WinSW 2 reads the settings above each time the service starts, so a restart is all an update needs.
  & $ServiceExe stopwait | Out-Null
} else {
  & $ServiceExe install
}
& $ServiceExe start

for ($i = 0; $i -lt 60; $i++) {
  if (Test-AtlasReady $existing) {
    Write-Host "MSP Atlas is running. Open $($existing['PUBLIC_URL'])."
    Write-Host "First install: the setup code is in $DataDir\logs\$ServiceName.out.log"
    if ($local) {
      Write-Host ''
      Write-Host "Atlas is at this server's own address, with its own certificate. Browsers on other computers warn"
      Write-Host "about it until they trust $CerFile (import it into Trusted Root Certification"
      Write-Host 'Authorities, or deploy it with Group Policy). Passkeys need a domain.'
      Write-Host 'Once Atlas has a domain and an HTTPS reverse proxy, run this again with -PublicUrl https://atlas.yourmsp.com.'
    }
    return
  }
  Start-Sleep -Seconds 2
}
throw "Atlas didn't become ready. Check $DataDir\logs for errors."
