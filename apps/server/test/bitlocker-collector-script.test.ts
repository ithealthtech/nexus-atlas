import { execFileSync } from 'node:child_process';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bitlockerReportSchema } from '@atlas/shared';
import { collectorScript } from '../src/services/bitlocker-collector-script.js';

const KEY = '111111-222222-333333-444444-555555-666666-077077-123453';
const AGENT = '0b9d6c1e-2222-4333-8444-555566667777';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const base64 = (url: string) => Buffer.from(url, 'base64url').toString('base64');
const values = {
  name: 'Harbor Dental: All workstations',
  agentId: AGENT,
  endpoint: 'https://atlas.example.com/api/bitlocker/ingest',
  token: 'ab'.repeat(32),
  modulus: base64(jwk.n),
  exponent: base64(jwk.e),
};

describe('BitLocker collector script', () => {
  it('carries the enrollment, with nothing left to fill in and nothing that could break out of a string', () => {
    const script = collectorScript(values);
    expect(script).toContain(`agentId     = '${AGENT}'`);
    expect(script).toContain(`endpoint    = 'https://atlas.example.com/api/bitlocker/ingest'`);
    expect(script).not.toMatch(/__[A-Z_]+__/);
    // Windows line endings throughout.
    expect(script.replace(/\r\n/g, '')).not.toContain('\n');
    // It can only read: no call that changes BitLocker appears anywhere in it.
    expect(script).not.toMatch(
      /ProtectKeyWith|DeleteKeyProtector|DisableKeyProtectors|Encrypt\(\)|Decrypt\(\)|manage-bde|Enable-BitLocker|Disable-BitLocker|Suspend-BitLocker|Add-BitLockerKeyProtector|Remove-BitLockerKeyProtector/i,
    );
    const drain = script.indexOf('if (-not $NoUpload) { Send-AtlasQueue -Root $root }');
    expect(drain).toBeGreaterThan(0);
    expect(drain).toBeLessThan(script.indexOf("throw 'Encrypted queue is full'"));
    for (const bad of [
      { ...values, endpoint: "https://atlas.example.com/x'; Remove-Item C:\\ -Recurse #" },
      { ...values, token: "'; evil" },
      { ...values, agentId: 'not-a-guid' },
      { ...values, modulus: '$(evil)' },
    ])
      expect(() => collectorScript(bad)).toThrow(/unexpected value/);
    // A name can't end the comment block it sits in.
    expect(collectorScript({ ...values, name: 'x #> Remove-Item $env:TEMP <#' })).not.toMatch(/Enrollment: .*[#<>$]/);
  });

  // Runs the script's own functions under Windows PowerShell 5.1 against made-up volumes: no real BitLocker data is
  // read and no administrator rights are needed, because everything it would ask Windows for is replaced.
  it.runIf(process.platform === 'win32')(
    'encrypts on Windows PowerShell 5.1 what Atlas can decrypt, and reports status without leaking anything',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'atlas-collector-'));
      try {
        const out = join(dir, 'report.json');
        const functions = collectorScript(values)
          .split('# --- run ---')[0]!
          .replace('#requires -RunAsAdministrator', '');
        const harness = `${functions}
function Get-ItemPropertyValue { param($LiteralPath, $Name) '6f1c2e9a-1111-4222-8333-444455556666' }
function Get-CimInstance {
    param($ClassName, $Namespace, $ErrorAction)
    if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ Caption = 'Microsoft Windows 11 Pro' } }
    if ($ClassName -eq 'Win32_BIOS') { return [pscustomobject]@{ SerialNumber = ' 5CG1234XYZ ' } }
    return @(
        [pscustomobject]@{ DeviceID = 'vol-c'; DriveLetter = 'C:' },
        [pscustomobject]@{ DeviceID = 'vol-d'; DriveLetter = 'D:' },
        [pscustomobject]@{ DeviceID = 'vol-locked'; DriveLetter = 'E:' }
    )
}
function Invoke-CimMethod {
    param($InputObject, $MethodName, $Arguments, $ErrorAction)
    if ($InputObject.DeviceID -eq 'vol-locked') { throw 'provider detail that must not be reported' }
    $on = $InputObject.DeviceID -eq 'vol-c'
    switch ($MethodName) {
        'GetProtectionStatus' { return [pscustomobject]@{ ReturnValue = 0; ProtectionStatus = [int]$on } }
        'GetConversionStatus' { return [pscustomobject]@{ ReturnValue = 0; EncryptionPercentage = $(if ($on) { 100 } else { 0 }); ConversionStatus = [int]$on } }
        'GetEncryptionMethod' { return [pscustomobject]@{ ReturnValue = 0; EncryptionMethod = $(if ($on) { 7 } else { 0 }) } }
        'GetKeyProtectors' { return [pscustomobject]@{ ReturnValue = 0; VolumeKeyProtectorID = $(if ($on) { @('{4F2A9C1E-7B44-4D0E-9A51-0C6E2B8D1F77}') } else { @() }) } }
        'GetKeyProtectorNumericalPassword' { return [pscustomobject]@{ ReturnValue = 0; NumericalPassword = '${KEY}' } }
    }
}
$rsa = New-AtlasPublicKey
$report = Get-AtlasReport -Rsa $rsa
[IO.File]::WriteAllText('${out}', (ConvertTo-Json -InputObject $report -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding($false)))
try { Invoke-AtlasReadMethod ([pscustomobject]@{ DeviceID = 'vol-c' }) 'DisableKeyProtectors'; Write-Output 'ALLOWLIST-BROKEN' } catch { Write-Output 'allowlist-ok' }
try { $null = Protect-AtlasPassword -Rsa $rsa -Password '123456-123456-123456-123456-123456-123456-123456-123456'; Write-Output 'FORMAT-BROKEN' } catch { Write-Output 'format-ok' }
# The queue: oldest first, a file removed only once its upload is acknowledged, and a failure leaves the rest.
$queue = Join-Path '${dir}' 'queue'
$null = New-Item -ItemType Directory -Path $queue
foreach ($n in 1..3) {
    $name = Join-Path $queue ("r$n.json")
    [IO.File]::WriteAllText($name, ('{"agentId":"' + $Config.agentId + '","n":' + $n + '}'))
    (Get-Item -LiteralPath $name).CreationTimeUtc = [DateTime]::UtcNow.AddMinutes($n - 10)
}
$script:sent = @()
function Send-AtlasReport { param([string]$Json) $n = ($Json | ConvertFrom-Json).n; if ($n -eq 3) { throw 'Upload temporarily unavailable' }; $script:sent += $n }
try { Send-AtlasQueue -Root $queue } catch { Write-Output 'queue-stopped' }
Write-Output ('queue-sent=' + ($script:sent -join ','))
Write-Output ('queue-left=' + ((Get-ChildItem -LiteralPath $queue -Filter '*.json' | ForEach-Object { $_.Name }) -join ','))
Write-Output ('ps-major=' + $PSVersionTable.PSVersion.Major)
`;
        const file = join(dir, 'harness.ps1');
        writeFileSync(file, harness.replace(/\r?\n/g, '\r\n'));
        const printed = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
          { encoding: 'utf8' },
        );
        expect(printed).toContain('allowlist-ok');
        expect(printed).toContain('format-ok');
        expect(printed).toContain('ps-major=5');
        expect(printed).toContain('queue-stopped');
        expect(printed).toContain('queue-sent=1,2');
        expect(printed).toContain('queue-left=r3.json');

        const raw = readFileSync(out, 'utf8');
        expect(raw).not.toContain(KEY);
        expect(raw).not.toContain('provider detail');
        expect(raw).not.toContain(values.token);
        const report = bitlockerReportSchema.parse(JSON.parse(raw));
        expect(report).toMatchObject({ agentId: AGENT, hostname: expect.any(String), serialNumber: '5CG1234XYZ' });
        const [c, d, locked] = report.volumes;
        expect(c).toMatchObject({
          mountPoint: 'C:',
          protection: 'On',
          encryptionMethod: 'XTS-AES-256',
          encryptionPercentage: 100,
          conversionStatus: 'Fully encrypted',
        });
        expect(c!.protectors).toHaveLength(1);
        expect(c!.protectors[0]!.keyId).toBe('4f2a9c1e-7b44-4d0e-9a51-0c6e2b8d1f77');
        expect(
          privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
            Buffer.from(c!.protectors[0]!.cipher, 'base64'),
          ).toString('utf8'),
        ).toBe(KEY);
        // An unencrypted volume is reported as off, with no keys and no complaint.
        expect(d).toMatchObject({ protection: 'Off', protectors: [] });
        expect(d!.error).toBeUndefined();
        expect(locked).toMatchObject({
          protection: 'Unknown',
          protectors: [],
          error: 'Volume details unavailable or volume locked',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
