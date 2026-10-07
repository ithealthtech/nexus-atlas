/**
 * The BitLocker collector: one self-contained script the RMM runs as SYSTEM. It works on Windows PowerShell 5.1
 * (what every supported Windows has) and on PowerShell 7. The enrollment's values replace the __NAME__ markers.
 *
 * The script only reads. Its WMI calls go through a fixed allowlist of read methods, so it cannot turn BitLocker
 * on or off, suspend it, or add, remove, or rotate a protector. It holds a public key only: it can encrypt
 * recovery passwords but cannot decrypt them, and its token can upload reports and nothing else.
 *
 * Written without backticks or dollar-brace so it can live in this template literal unchanged.
 */
const SCRIPT = String.raw`#requires -Version 5.1
#requires -RunAsAdministrator
<#
MSP Atlas BitLocker collector (version __VERSION__)
Enrollment: __NAME__

Run as SYSTEM from your RMM, on a schedule (every 6 hours is plenty) and after a recovery key is rotated.
Reads BitLocker status and recovery passwords, encrypts each password on this machine with the enrollment's
public key, and uploads the report to Atlas. It changes nothing on the machine apart from its own queue folder.

  -NoUpload   Collect and queue only (reports stay encrypted in the queue until a later run uploads them).

Exit 0: collected and uploaded (or queued with -NoUpload). Exit 10: something failed; encrypted reports stay queued.
Treat this file as a secret: it contains an upload token for this enrollment.
#>
[CmdletBinding()]
param(
    [string]$QueueDirectory = "$env:ProgramData\MSPAtlas\BitLocker\Queue",
    [switch]$NoUpload
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

$Config = @{
    agentId     = '__AGENT_ID__'
    endpoint    = '__ENDPOINT__'
    uploadToken = '__TOKEN__'
    modulus     = '__MODULUS__'
    exponent    = '__EXPONENT__'
}

function New-AtlasPublicKey {
    $parameters = New-Object System.Security.Cryptography.RSAParameters
    $parameters.Modulus = [Convert]::FromBase64String($Config.modulus)
    $parameters.Exponent = [Convert]::FromBase64String($Config.exponent)
    $rsa = New-Object System.Security.Cryptography.RSACng
    $rsa.ImportParameters($parameters)
    if ($rsa.KeySize -ne 3072) { $rsa.Dispose(); throw 'Invalid enrollment key' }
    return $rsa
}

function Protect-AtlasPassword {
    param([Parameter(Mandatory)]$Rsa, [Parameter(Mandatory)][string]$Password)
    if ($Password -notmatch '^(\d{6}-){7}\d{6}$') { throw 'Invalid recovery password format' }
    foreach ($group in $Password.Split('-')) {
        if ([int]$group -gt 720885 -or [int]$group % 11 -ne 0) { throw 'Invalid recovery password format' }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Password)
    try {
        return [Convert]::ToBase64String($Rsa.Encrypt($bytes, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Invoke-AtlasReadMethod {
    param($Volume, [string]$Method, [hashtable]$Arguments = @{})
    # Fixed allowlist: this collector cannot call a method that changes BitLocker.
    if ($Method -notin @('GetProtectionStatus', 'GetConversionStatus', 'GetEncryptionMethod', 'GetKeyProtectors', 'GetKeyProtectorNumericalPassword')) { throw 'Read method not allowed' }
    $result = Invoke-CimMethod -InputObject $Volume -MethodName $Method -Arguments $Arguments -ErrorAction Stop
    if ($result.ReturnValue -ne 0) { throw 'BitLocker read failed' }
    return $result
}

function Get-AtlasReport {
    param([Parameter(Mandatory)]$Rsa)
    $machineId = [guid](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid)
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop
    $volumes = @(Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -ErrorAction Stop)
    $methodNames = @('None', 'AES-128 with diffuser', 'AES-256 with diffuser', 'AES-128', 'AES-256', 'Hardware encryption', 'XTS-AES-128', 'XTS-AES-256')
    $conversionNames = @('Fully decrypted', 'Fully encrypted', 'Encrypting', 'Decrypting', 'Encryption paused', 'Decryption paused')
    $resultVolumes = New-Object System.Collections.Generic.List[object]
    foreach ($volume in $volumes) {
        $protectors = New-Object System.Collections.Generic.List[object]
        $record = [ordered]@{
            volumeId             = [string]$volume.DeviceID
            mountPoint           = [string]$volume.DriveLetter
            protection           = 'Unknown'
            encryptionMethod     = 'Unknown'
            encryptionPercentage = 0
            conversionStatus     = 'Unknown'
        }
        $problem = $null
        try {
            $protection = Invoke-AtlasReadMethod $volume 'GetProtectionStatus'
            $record.protection = switch ([int]$protection.ProtectionStatus) { 0 { 'Off' } 1 { 'On' } default { 'Unknown' } }
            $conversion = Invoke-AtlasReadMethod $volume 'GetConversionStatus'
            $record.encryptionPercentage = [int]$conversion.EncryptionPercentage
            if ([int]$conversion.ConversionStatus -lt $conversionNames.Count) { $record.conversionStatus = $conversionNames[[int]$conversion.ConversionStatus] }
            $method = Invoke-AtlasReadMethod $volume 'GetEncryptionMethod'
            if ([int]$method.EncryptionMethod -lt $methodNames.Count) { $record.encryptionMethod = $methodNames[[int]$method.EncryptionMethod] }
            # Type 3 is a numerical recovery password. TPM secrets and PINs are never read.
            $ids = Invoke-AtlasReadMethod $volume 'GetKeyProtectors' @{ KeyProtectorType = [uint32]3 }
            foreach ($id in @($ids.VolumeKeyProtectorID)) {
                if (-not $id) { continue }
                $secret = $null
                try {
                    $secret = Invoke-AtlasReadMethod $volume 'GetKeyProtectorNumericalPassword' @{ VolumeKeyProtectorID = $id }
                    $sealed = Protect-AtlasPassword -Rsa $Rsa -Password ([string]$secret.NumericalPassword)
                    $protectors.Add([ordered]@{ keyId = ([guid]$id).ToString(); cipher = $sealed })
                } catch {
                    $problem = 'One or more recovery protectors could not be read'
                } finally { $secret = $null }
            }
            if ($protectors.Count -eq 0 -and -not $problem -and $record.protection -eq 'On') { $problem = 'No numerical recovery password protector found' }
        } catch {
            # The provider's own error text is not reported: it can carry details that don't belong in a log.
            $problem = 'Volume details unavailable or volume locked'
        }
        if ($problem) { $record.error = $problem }
        $record.protectors = @($protectors.ToArray())
        $resultVolumes.Add($record)
    }
    return [ordered]@{
        version      = 1
        reportId     = [guid]::NewGuid().ToString()
        agentId      = [string]$Config.agentId
        collectedAt  = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        machineId    = $machineId.ToString()
        hostname     = [string]$env:COMPUTERNAME
        os           = [string]$os.Caption
        serialNumber = ([string]$bios.SerialNumber).Trim()
        volumes      = @($resultVolumes.ToArray())
    }
}

function Assert-AtlasEndpoint {
    $uri = [uri][string]$Config.endpoint
    $loopback = $uri.IsAbsoluteUri -and $uri.Scheme -eq 'http' -and $uri.IsLoopback
    if (-not $uri.IsAbsoluteUri -or ($uri.Scheme -ne 'https' -and -not $loopback) -or $uri.UserInfo -or $uri.Fragment -or $uri.Query) {
        throw 'Upload requires an HTTPS address without credentials, query, or fragment'
    }
    return $uri
}

function Send-AtlasReport {
    param([Parameter(Mandatory)][string]$Json)
    $uri = Assert-AtlasEndpoint
    if ([string]$Config.uploadToken -notmatch '^[a-f0-9]{64}$') { throw 'Invalid upload credential' }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    # Certificate and host name checks stay on.
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    try {
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $uri)
            $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', [string]$Config.uploadToken)
            $request.Content = New-Object System.Net.Http.StringContent($Json, [Text.Encoding]::UTF8, 'application/json')
            $response = $null
            $status = 0
            $body = $null
            try {
                $response = $client.SendAsync($request).GetAwaiter().GetResult()
                $status = [int]$response.StatusCode
                if ($status -eq 200) { $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json }
            } catch {
                # A connection failure or timeout: tried again below.
                $status = 0
            } finally {
                if ($null -ne $response) { $response.Dispose() }
                $request.Dispose()
            }
            if ($status -eq 200) {
                $names = @($body.PSObject.Properties.Name)
                if (($names -contains 'accepted' -and $body.accepted -eq $true) -or ($names -contains 'duplicate' -and $body.duplicate -eq $true)) { return }
                throw 'Unexpected upload acknowledgment'
            }
            if ($status -ne 0 -and $status -ne 408 -and $status -ne 429 -and $status -lt 500) { throw 'Upload rejected; check that the enrollment has not been revoked' }
            if ($attempt -eq 2) { throw 'Upload temporarily unavailable' }
            Start-Sleep -Seconds (([int][Math]::Pow(2, $attempt + 1)) + (Get-Random -Minimum 0 -Maximum 3))
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}

function Send-AtlasQueue {
    param([Parameter(Mandatory)][string]$Root)
    # Oldest first, so key rotations during an outage arrive in order. Up to 50 a call.
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Filter '*.json' -File | Sort-Object CreationTimeUtc | Select-Object -First 50)) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected queue file type' }
        $queued = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
        $parsed = $queued | ConvertFrom-Json
        if ($parsed.agentId -ne $Config.agentId) { throw 'Queue enrollment mismatch' }
        Send-AtlasReport -Json $queued
        # Only an acknowledged report is removed.
        Remove-Item -LiteralPath $file.FullName
    }
}

# --- run ---
$rsa = $null
try {
    if (-not [Environment]::Is64BitProcess) { throw 'Requires 64-bit PowerShell' }
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $agentGuid = [guid]::Empty
    if (-not [guid]::TryParse([string]$Config.agentId, [ref]$agentGuid)) { throw 'Invalid enrollment configuration' }
    # The public key is checked before any recovery material is read.
    $rsa = New-AtlasPublicKey
    if (-not $NoUpload) { $null = Assert-AtlasEndpoint }
    $root = [IO.Path]::GetFullPath($QueueDirectory)
    if ($root -notmatch '^[A-Za-z]:\\') { throw 'Queue must be on a local drive' }
    $root = $root.TrimEnd('\') + '\' + $agentGuid.ToString()
    $directory = New-Item -ItemType Directory -Path $root -Force
    # A junction or symbolic link anywhere above the queue could redirect it somewhere readable.
    $ancestor = $directory
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Queue path cannot contain reparse points' }
        $ancestor = $ancestor.Parent
    }
    # SYSTEM and Administrators only; nothing inherited.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    # One run at a time per enrollment, even if the RMM starts two.
    $lock = [IO.File]::Open((Join-Path $root 'collector.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        # What earlier runs left behind goes first, so a queue that filled up during an outage empties again
        # instead of blocking every later run.
        if (-not $NoUpload) { Send-AtlasQueue -Root $root }
        $pending = @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File)
        if ($pending.Count -ge 100) { throw 'Encrypted queue is full' }
        $report = Get-AtlasReport -Rsa $rsa
        $json = ConvertTo-Json -InputObject $report -Depth 10 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 100000) { throw 'Report exceeds the supported size' }
        $path = Join-Path $root ($report.reportId + '.json')
        $tempPath = $path + '.tmp'
        [IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tempPath -Destination $path
        $keyCount = 0
        foreach ($volume in $report.volumes) { $keyCount += @($volume.protectors).Count }
        if (-not $NoUpload) { Send-AtlasQueue -Root $root }
        $mode = if ($NoUpload) { 'queued' } else { 'uploaded' }
        # Output for the RMM log: counts only, never keys, tokens, or provider errors.
        Write-Output ("MSP Atlas BitLocker: report {0}; volumes={1}; recoveryPasswords={2}" -f $mode, @($report.volumes).Count, $keyCount)
    } finally { $lock.Dispose() }
    exit 0
} catch {
    Write-Output 'MSP Atlas BitLocker: collection or upload failed. Encrypted reports stay queued. Check that the script runs as SYSTEM, the enrollment is not revoked, and Atlas is reachable.'
    exit 10
} finally {
    if ($null -ne $rsa) { $rsa.Dispose() }
}
`;

/** The collector script version; raise it when the script changes, so installed copies can be told apart. */
export const COLLECTOR_VERSION = '1';

/** The script with an enrollment's values filled in. Every value is checked to be safe inside a quoted string. */
export function collectorScript(values: {
  name: string;
  agentId: string;
  endpoint: string;
  token: string;
  modulus: string;
  exponent: string;
}): string {
  const safe: [string, string, RegExp][] = [
    ['__AGENT_ID__', values.agentId, /^[0-9a-f-]{36}$/],
    ['__ENDPOINT__', values.endpoint, /^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9/._-]*$/],
    ['__TOKEN__', values.token, /^[a-f0-9]{64}$/],
    ['__MODULUS__', values.modulus, /^[A-Za-z0-9+/]+={0,2}$/],
    ['__EXPONENT__', values.exponent, /^[A-Za-z0-9+/]+={0,2}$/],
  ];
  let script = SCRIPT.replace('__VERSION__', COLLECTOR_VERSION).replace(
    '__NAME__',
    // A comment line: anything that could end the comment block or start a new line is dropped.
    values.name.replace(/[^\w .,()&'/-]+/g, ' ').slice(0, 120),
  );
  for (const [marker, value, shape] of safe) {
    if (!shape.test(value)) throw new Error(`The collector script can't be made: ${marker} has an unexpected value.`);
    script = script.replace(marker, value);
  }
  // Windows line endings, as RMM script editors and Windows PowerShell expect.
  return script.replace(/\r?\n/g, '\r\n');
}
