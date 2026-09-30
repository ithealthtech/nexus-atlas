<#
.SYNOPSIS
  Rotates one account's password for MSP Atlas. Run by ConnectWise RMM as SYSTEM; Atlas starts it and fills in
  the parameters.

.DESCRIPTION
  1. Generates a password to the policy Atlas sent (length and character kinds) with a cryptographic generator.
  2. Reports it to Atlas BEFORE changing anything. Atlas holds it, encrypted, until step 4. If Atlas doesn't
     accept it, the script stops and the account is left as it was.
  3. Sets the password: a local account on this device, or (AccountType ad_service) an Active Directory account,
     which needs the ActiveDirectory PowerShell module (run it on a domain controller or a server with RSAT).
  4. Tells Atlas whether that worked. Only then does Atlas replace the password in the vault; a failure keeps the
     old one there and alerts the administrators.

  The token is good for this one rotation only, for two hours, and can do nothing but report on it. The password
  is never written to the console, a file, or the RMM's script output.

.NOTES
  Import this file into ConnectWise RMM (Automation > Scripts) as a PowerShell script with the parameters below,
  then enter the script's ID in Atlas (Administration > Password rotation).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $AtlasUrl,
  [Parameter(Mandatory)] [string] $Token,
  [Parameter(Mandatory)] [ValidateSet('local_admin', 'ad_service')] [string] $AccountType,
  [Parameter(Mandatory)] [string] $Account,
  [ValidateRange(12, 128)] [int] $Length = 24,
  [string] $Upper = '1',
  [string] $Lower = '1',
  [string] $Digits = '1',
  [string] $Symbols = '1'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = $AtlasUrl.TrimEnd('/')
if ($base -notmatch '^https://') { Write-Output 'Atlas must be reached over https://. Nothing was changed.'; exit 2 }

function Send-Atlas([string] $Path, [hashtable] $Body) {
  $json = $Body | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$base/api/rotation/agent/$Path" -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $Token" } -Body $json -TimeoutSec 60 | Out-Null
}

function Get-Reason($ErrorRecord) {
  # Atlas explains a refusal in {"error": "..."}; anything else is summarised without the request.
  $detail = $ErrorRecord.ErrorDetails.Message
  if ($detail) { try { return ($detail | ConvertFrom-Json).error } catch { return $detail } }
  return $ErrorRecord.Exception.Message
}

function New-RotationPassword {
  $sets = @()
  if ($Upper -eq '1') { $sets += , 'ABCDEFGHJKLMNPQRSTUVWXYZ'.ToCharArray() }
  if ($Lower -eq '1') { $sets += , 'abcdefghijkmnopqrstuvwxyz'.ToCharArray() }
  if ($Digits -eq '1') { $sets += , '23456789'.ToCharArray() }
  if ($Symbols -eq '1') { $sets += , '!#$%&*+-=?@^_~'.ToCharArray() }
  if ($sets.Count -lt 2) { throw 'The policy needs at least two kinds of character.' }
  $all = @($sets | ForEach-Object { $_ })
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $pick = {
    param($chars)
    # Rejection sampling, so every character is equally likely.
    $limit = 256 - (256 % $chars.Count)
    $b = New-Object byte[] 1
    do { $rng.GetBytes($b) } while ($b[0] -ge $limit)
    $chars[$b[0] % $chars.Count]
  }
  $out = New-Object System.Collections.Generic.List[char]
  foreach ($set in $sets) { $out.Add((& $pick $set)) }
  while ($out.Count -lt $Length) { $out.Add((& $pick $all)) }
  # Shuffle (Fisher-Yates), so the guaranteed characters aren't always first.
  for ($i = $out.Count - 1; $i -gt 0; $i--) {
    $j = [int](& $pick (0..$i))
    $t = $out[$i]; $out[$i] = $out[$j]; $out[$j] = $t
  }
  $rng.Dispose()
  -join $out
}

# The account's own name: "HOST\admin", ".\admin", "DOMAIN\svc" and "svc@domain.example" all name one account.
$name = ($Account -split '\\')[-1]
if ($AccountType -eq 'ad_service') { $name = ($name -split '@')[0] }
if (-not $name) { Write-Output 'No account name was given. Nothing was changed.'; exit 2 }

$password = New-RotationPassword

try {
  Send-Atlas 'candidate' @{ password = $password }
} catch {
  Write-Output "Atlas did not accept the new password, so nothing was changed: $(Get-Reason $_)"
  exit 1
}

$failure = $null
try {
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  if ($AccountType -eq 'ad_service') {
    Import-Module ActiveDirectory
    Set-ADAccountPassword -Identity $name -Reset -NewPassword $secure
  } elseif (Get-Command Set-LocalUser -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $name -Password $secure
  } else {
    # Windows PowerShell before 5.1 has no LocalAccounts module.
    ([ADSI]"WinNT://$env:COMPUTERNAME/$name,user").SetPassword($password)
  }
} catch {
  $failure = $_.Exception.Message
}
$password = $null
$secure = $null

$report = if ($failure) { @{ ok = $false; error = "Setting the password failed: $failure" } } else { @{ ok = $true } }
for ($attempt = 1; $attempt -le 5; $attempt++) {
  try {
    Send-Atlas 'result' $report
    break
  } catch {
    if ($attempt -eq 5) {
      if ($failure) {
        Write-Output "The password was not changed ($failure), and Atlas could not be told: $(Get-Reason $_)"
      } else {
        Write-Output "The password WAS changed, but Atlas could not be told: $(Get-Reason $_). Atlas keeps the new password in the entry's history."
      }
      exit 1
    }
    Start-Sleep -Seconds (5 * $attempt)
  }
}

if ($failure) { Write-Output "The password was not changed: $failure"; exit 1 }
Write-Output "The password for $name was rotated and saved in Atlas."
