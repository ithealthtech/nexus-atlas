# Keyhaven Windows collector — RMM deployment

## What this release does
Reads BitLocker volumes through Microsoft's Win32_EncryptableVolume provider. Reports the Windows machine ID, hostname, OS, BIOS serial number, volume ID/mount point, encryption method/percentage, protection/conversion status, and numerical recovery protector IDs. Each 48-digit password is RSA-OAEP-SHA256 encrypted on the endpoint with its enrollment's 3072-bit public key. The collector has no decryption key or vault passphrase.

No BitLocker settings are modified. Missing/locked volumes or recovery protectors are reported without inventing keys. It never creates a protector, enables encryption, suspends protection, or rotates keys.

## Requirements
- Windows with the BitLocker WMI provider installed.
- 64-bit PowerShell 7.4 or newer.
- RMM execution as LocalSystem or an elevated administrator.
- One enrollment/configuration per device. Do not reuse a fleet-wide credential or bake an enrollment into a cloned image. Enrollment binds to MachineGuid on first accepted report; this is not hardware attestation.
- Protect the scripts and config from non-administrator modification. Config contains a write-only upload token.

## First use with the current local/private vault
1. In Keyhaven, open **Collection agents**, enter a client tenant/device label, and create an enrollment with a strong recovery passphrase. Save this passphrase in the MSP's established password manager. Download the configuration once; its token is not retrievable later.
2. Through the RMM, stage both scripts in a protected folder such as C:\ProgramData\Keyhaven\Agent. Stage that device's configuration as C:\ProgramData\Keyhaven\Config\device.json. Grant file/folder access only to SYSTEM and local Administrators, including the parent folder, and use the RMM's secret-file mechanism.
3. Run as SYSTEM with 64-bit PowerShell 7.4+:

   pwsh.exe -NoProfile -NonInteractive -File "C:\ProgramData\Keyhaven\Agent\Invoke-KeyhavenCollector.ps1" -ConfigPath "C:\ProgramData\Keyhaven\Config\device.json"

4. Retrieve encrypted .json report files from C:\ProgramData\Keyhaven\Queue\<agentId> through the RMM, then use **Import encrypted report** in the vault. Import oldest first. Reports contain encrypted keys plus readable device metadata; treat the whole report as client-confidential. The upload credential is never included in a report.
5. Open the device's key in the vault using its enrollment recovery passphrase. If a different vault passphrase is cached, lock the vault first.

## Automatic RMM upload
The collector and /api/agent-ingest handler are implemented, but the current private Sites interactive sign-in gate does not admit an unattended bearer-token request. Publishing the private site alone does not enable agent upload. Keep using encrypted report import until a machine-accessible deployment is configured. Do not make the administrative vault public or disable its authentication to work around this.

On an appropriately deployed HTTPS ingestion endpoint, set the config's endpoint to the exact HTTPS /api/agent-ingest URL and append **-Upload** to the command above. The endpoint uses only the per-device bearer token. It cannot read vault data or choose another tenant. It ignores no certificate errors and follows no redirects. The endpoint URL cannot contain user credentials, query parameters, or a fragment.

RMM schedule: every 6 hours with device-level random staggering, and after approved protector rotation. Schedule and installation are owned by the RMM; this script creates no service or scheduled task. Start with a small pilot. No RMM vendor-specific deployment has been made.

## Queue and failure behavior
- Before networking, writes only encrypted report contents to an ACL-protected local queue.
- Serializes concurrent runs per enrollment with an exclusive file lock.
- Uploads oldest first, up to 50 reports per run, with three bounded attempts for transient failures.
- Removes a queued file only after an accepted/duplicate/stale acknowledgment. Stale reports are ignored by the server; preserve/report older key rotations before submitting newer reports.
- Refuses to collect when the queue reaches 100 reports; alerts in RMM should flag nonzero exit codes. An offline import does not automatically clear endpoint queue files; clear already-imported encrypted files through your RMM retention procedure.
- Exit 0: collection/queueing or requested upload completed. Exit 10: configuration, collection, queue or upload failure. Per-volume read failures appear in the report and may still return 0, so inspect volume warnings as well.
- Console output contains counts and generic errors only. Plaintext secrets exist briefly in managed memory; managed strings cannot be guaranteed zeroized.
- No plaintext recovery keys or passphrases are written to disk. Metadata remains readable. Keep PowerShell transcription/debugging and RMM secret-capture policies under your organization's controls.
- Revoking enrollment stops import and upload; existing escrowed keys remain recoverable. Re-enroll a replaced/reimaged device rather than transferring its old configuration.

## Security and production boundaries
The API checks report limits, revocation, owner/tenant assignment, machine binding, duplicate reports and stale timestamps. Ingestion is transactional; repeated reports do not create duplicate key rows. Device metadata is endpoint-reported and is not attested. A stolen upload token can submit falsified reports for its bound machine; it cannot decrypt escrowed keys or read the administrative API.

Production still needs code signing, signed release distribution, operational rate limiting, monitoring, backup/restore, identity/technician roles, and an approved deployment exposing only the ingestion handler to machine clients. Do not use this pilot as the sole copy of recovery keys.

## Validation
Tests use mocked Windows inventory and synthetic recovery passwords. They do not invoke the local machine's BitLocker provider or collect real recovery secrets. Actual RMM execution and live BitLocker hardware validation remain a deployment pilot step.

Microsoft API references:
- https://learn.microsoft.com/windows/win32/secprov/getkeyprotectors-win32-encryptablevolume
- https://learn.microsoft.com/windows/win32/secprov/getkeyprotectornumericalpassword-win32-encryptablevolume
- https://learn.microsoft.com/windows/win32/secprov/getconversionstatus-win32-encryptablevolume
