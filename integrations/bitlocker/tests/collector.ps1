param([Parameter(Mandatory)][string]$FixturePath,[Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/../agent/Keyhaven.Core.ps1"
$fixture=Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
function Get-ItemPropertyValue { return '11111111-1111-4111-8111-111111111111' }
function Get-CimInstance {
 param($ClassName,$Namespace,$ErrorAction)
 switch ($ClassName) {
  'Win32_OperatingSystem' { return [pscustomobject]@{Caption='Windows 11 Test'} }
  'Win32_BIOS' { return [pscustomobject]@{SerialNumber='SYNTHETIC-ONLY'} }
  'Win32_EncryptableVolume' { return @([pscustomobject]@{DeviceID='test-volume-1';DriveLetter='C:'},[pscustomobject]@{DeviceID='test-volume-2';DriveLetter='D:'},[pscustomobject]@{DeviceID='locked-volume';DriveLetter='E:'}) }
  default { throw 'Unexpected inventory read' }
 }
}
function Invoke-CimMethod {
 param($InputObject,$MethodName,$Arguments,$ErrorAction)
 if ($InputObject.DeviceID -eq 'locked-volume') { throw 'Synthetic locked volume' }
 switch ($MethodName) {
 'GetProtectionStatus' { return [pscustomobject]@{ReturnValue=0;ProtectionStatus=1} }
 'GetConversionStatus' { return [pscustomobject]@{ReturnValue=0;EncryptionPercentage=100;ConversionStatus=1} }
 'GetEncryptionMethod' { return [pscustomobject]@{ReturnValue=0;EncryptionMethod=7} }
 'GetKeyProtectors' {
  if ($Arguments.KeyProtectorType -ne 3) { throw 'Wrong protector type' }
  $ids=if ($InputObject.DeviceID -eq 'test-volume-2') {@()} else {@('{22222222-2222-4222-8222-222222222222}','{33333333-3333-4333-8333-333333333333}')}
  return [pscustomobject]@{ReturnValue=0;VolumeKeyProtectorID=$ids}
 }
 'GetKeyProtectorNumericalPassword' { return [pscustomobject]@{ReturnValue=0;NumericalPassword=$fixture.password} }
 default { throw 'Mutation or unexpected method attempted' }
 }
}
$report=Get-KeyhavenReport -Config $fixture.config
$json=ConvertTo-Json -InputObject $report -Depth 10 -Compress
if ($json.Contains($fixture.password)) { throw 'Plaintext leaked into report' }
if ($json.Contains($fixture.config.uploadToken)) { throw 'Credential leaked into report' }
if ($report.volumes.Count -ne 3 -or $report.volumes[0].protectors.Count -ne 2) { throw 'Protector collection incomplete' }
if ($report.volumes[1].error -ne 'No numerical recovery password protector found') { throw 'Missing-key state not reported' }
if ($report.volumes[2].error -ne 'Volume details unavailable or volume locked') { throw 'Locked-volume state not reported' }
if ((Protect-KeyhavenPassword $fixture.config.publicKey $fixture.password) -eq $report.volumes[0].protectors[0].cipher) { throw 'Encryption is not randomized' }
foreach ($url in @('http://example.test/api','https://user:password@example.test/api','https://example.test/api?token=x','https://example.test/api#x')) {
 $rejected=$false;try {$null=Assert-KeyhavenEndpoint $url} catch {$rejected=$true};if(-not $rejected){throw 'Unsafe endpoint allowed'}
}
$null=Assert-KeyhavenEndpoint 'https://ingest.example.test/api/agent-ingest'
$rejected=$false;try {$null=Invoke-KeyhavenReadMethod $null 'Encrypt'} catch {$rejected=$true};if(-not $rejected){throw 'Mutation allowed'}
[IO.File]::WriteAllText($OutputPath,$json)
Write-Output 'PASS: mocked collection, all numerical protectors, locked/missing-key reports, encryption, endpoint validation, read-only method allowlist.'
