#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('Keyhaven.AgentCrypto' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Security.Cryptography;
using System.Text;
namespace Keyhaven {
    public static class AgentCrypto {
        public static string Encrypt(string publicKey, string password) {
            using (RSA rsa = RSA.Create()) {
                byte[] der = Convert.FromBase64String(publicKey);
                int consumed;
                rsa.ImportSubjectPublicKeyInfo(der, out consumed);
                if (consumed != der.Length || rsa.KeySize != 3072) throw new ArgumentException("Invalid enrollment key");
                byte[] bytes = Encoding.UTF8.GetBytes(password);
                try { return Convert.ToBase64String(rsa.Encrypt(bytes, RSAEncryptionPadding.OaepSHA256)); }
                finally { CryptographicOperations.ZeroMemory(bytes); }
            }
        }
    }
}
"@
}

function Protect-KeyhavenPassword {
    param([Parameter(Mandatory)][string]$PublicKey,[Parameter(Mandatory)][string]$Password)
    if ($Password -notmatch '^(\d{6}-){7}\d{6}$') { throw 'Invalid recovery password format' }
    foreach ($group in $Password.Split('-')) {
        if ([int]$group -gt 720885 -or [int]$group % 11 -ne 0) { throw 'Invalid recovery password format' }
    }
    return [Keyhaven.AgentCrypto]::Encrypt($PublicKey,$Password)
}

function Invoke-KeyhavenReadMethod {
    param($Volume,[string]$Method,[hashtable]$Arguments=@{})
    # Fixed allowlist: this collector cannot invoke BitLocker mutation methods.
    if ($Method -notin @('GetProtectionStatus','GetConversionStatus','GetEncryptionMethod','GetKeyProtectors','GetKeyProtectorNumericalPassword')) { throw 'Read method not allowed' }
    $result = Invoke-CimMethod -InputObject $Volume -MethodName $Method -Arguments $Arguments -ErrorAction Stop
    if ($result.ReturnValue -ne 0) { throw 'BitLocker read failed' }
    return $result
}

function Get-KeyhavenReport {
    param([Parameter(Mandatory)]$Config)
    $machineId = [guid](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid)
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop
    $volumes = @(Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -ErrorAction Stop)
    $methodNames = @('None','AES-128 with diffuser','AES-256 with diffuser','AES-128','AES-256','Hardware encryption','XTS-AES-128','XTS-AES-256')
    $conversionNames = @('Fully decrypted','Fully encrypted','Encrypting','Decrypting','Encryption paused','Decryption paused')
    $resultVolumes = [System.Collections.Generic.List[object]]::new()
    foreach ($volume in $volumes) {
        $record = [ordered]@{
            volumeId=[string]$volume.DeviceID
            mountPoint=[string]$volume.DriveLetter
            protection='Unknown'
            encryptionMethod='Unknown'
            encryptionPercentage=0
            conversionStatus='Unknown'
            protectors=@()
        }
        try {
            $protection = Invoke-KeyhavenReadMethod $volume 'GetProtectionStatus'
            $record.protection = switch ([int]$protection.ProtectionStatus) { 0 {'Off'} 1 {'On'} default {'Unknown'} }
            $conversion = Invoke-KeyhavenReadMethod $volume 'GetConversionStatus'
            $record.encryptionPercentage = [int]$conversion.EncryptionPercentage
            if ([int]$conversion.ConversionStatus -lt $conversionNames.Count) { $record.conversionStatus=$conversionNames[[int]$conversion.ConversionStatus] }
            $method = Invoke-KeyhavenReadMethod $volume 'GetEncryptionMethod'
            if ([uint32]$method.EncryptionMethod -lt $methodNames.Count) { $record.encryptionMethod=$methodNames[[int]$method.EncryptionMethod] }
            # Type 3 is a numerical recovery-password protector. Never reads TPM secrets or PINs.
            $ids = Invoke-KeyhavenReadMethod $volume 'GetKeyProtectors' @{KeyProtectorType=[uint32]3}
            foreach ($id in @($ids.VolumeKeyProtectorID)) {
                if (-not $id) { continue }
                $secret = $null
                try {
                    $secret = Invoke-KeyhavenReadMethod $volume 'GetKeyProtectorNumericalPassword' @{VolumeKeyProtectorID=$id}
                    $sealed = Protect-KeyhavenPassword -PublicKey $Config.publicKey -Password $secret.NumericalPassword
                    $record.protectors += @{keyId=([guid]$id).ToString();cipher=$sealed}
                } catch {
                    $record.error='One or more recovery protectors could not be read'
                } finally {
                    if ($null -ne $secret) { $secret.NumericalPassword=$null }
                    $secret=$null
                }
            }
            if ($record.protectors.Count -eq 0 -and -not $record.Contains('error')) { $record.error='No numerical recovery password protector found' }
        } catch {
            # Do not print exception text: provider errors may contain sensitive details.
            $record.error='Volume details unavailable or volume locked'
        }
        $resultVolumes.Add($record)
    }
    return [ordered]@{
        version=1;reportId=[guid]::NewGuid().ToString();agentId=[string]$Config.agentId
        collectedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        machineId=$machineId.ToString();hostname=[string]$env:COMPUTERNAME
        os=[string]$os.Caption;serialNumber=[string]$bios.SerialNumber
        volumes=@($resultVolumes.ToArray())
    }
}

function Assert-KeyhavenEndpoint {
    param([string]$Endpoint)
    $uri = [uri]$Endpoint
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment -or $uri.Query) {
        throw 'Upload requires an HTTPS URL without credentials, query, or fragment'
    }
    return $uri
}

function Send-KeyhavenReport {
    param([Parameter(Mandatory)][string]$Json,[Parameter(Mandatory)]$Config)
    $uri = Assert-KeyhavenEndpoint ([string]$Config.endpoint)
    if ([string]$Config.uploadToken -notmatch '^[a-f0-9]{64}$') { throw 'Invalid upload credential' }
    $handler=[System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect=$false
    $handler.UseCookies=$false
    # Default certificate and hostname validation remain enabled.
    $client=[System.Net.Http.HttpClient]::new($handler)
    $client.Timeout=[TimeSpan]::FromSeconds(45)
    try {
        for ($attempt=0;$attempt -lt 3;$attempt++) {
            $request=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post,$uri)
            $request.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',[string]$Config.uploadToken)
            $request.Content=[System.Net.Http.StringContent]::new($Json,[Text.Encoding]::UTF8,'application/json')
            $response=$null
            try {
                $response=$client.SendAsync($request).GetAwaiter().GetResult()
                $status=[int]$response.StatusCode
                if ($status -eq 200) {
                    $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                    if ($body.accepted -eq $true -or ($body.PSObject.Properties.Name -contains 'duplicate' -and $body.duplicate -eq $true) -or ($body.PSObject.Properties.Name -contains 'stale' -and $body.stale -eq $true)) { return }
                    throw 'Unexpected upload acknowledgment'
                }
                if ($status -ne 408 -and $status -ne 429 -and $status -lt 500) { throw 'Upload rejected; check enrollment and endpoint access' }
                if ($attempt -eq 2) { throw 'Upload temporarily unavailable' }
            } catch [System.Net.Http.HttpRequestException] {
                if ($attempt -eq 2) { throw 'Upload connection failed' }
            } catch [System.Threading.Tasks.TaskCanceledException] {
                if ($attempt -eq 2) { throw 'Upload timed out' }
            } finally {
                if ($null -ne $response) { $response.Dispose() }
                $request.Dispose()
            }
            Start-Sleep -Seconds (([int][Math]::Pow(2,$attempt+1)) + (Get-Random -Minimum 0 -Maximum 3))
        }
    } finally { $client.Dispose();$handler.Dispose() }
}
