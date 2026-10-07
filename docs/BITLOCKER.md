# BitLocker in Atlas

Atlas keeps BitLocker recovery keys in the vault, as entries of the type **BitLocker recovery key**, and can show each machine's encryption status on its asset. Keys get there three ways:

1. **By hand.** Add a BitLocker recovery key entry under a client's Passwords.
2. **From a ConnectWise RMM custom field.** If something already writes recovery keys into a device custom field, the ConnectWise RMM sync's **BitLocker keys** option saves them to the vault. See the admin guide.
3. **The BitLocker collector.** A script your RMM runs on each Windows machine reads the keys and the encryption status itself and uploads them. This document describes it.

The collector was ported from the standalone project kept under `integrations/bitlocker` (reference only; none of that code runs in Atlas).

## How the collector works

**Enrollment.** An administrator makes an enrollment for a client under **Administration → BitLocker collector**. Atlas generates a 3072-bit RSA key pair and a random upload token, and hands back a PowerShell script with the enrollment's ID, the public key, and the token inside. The token is stored only as a SHA-256 hash, so the script is the one copy: lose it and you make a new enrollment. The private key is sealed with the organization's vault key (so it follows master-key rotation like every other secret).

An enrollment is for **all of a client's devices** (one script for the RMM to run everywhere) or for **one device** (tied to the first machine that reports with it; any other is refused).

**On the machine.** The script runs as SYSTEM, on Windows PowerShell 5.1 or later. It:

- reads volumes through `Win32_EncryptableVolume`, calling only a fixed list of read methods (protection status, conversion status, encryption method, key protector IDs, numerical passwords). It cannot enable, disable, or suspend BitLocker, or add, remove, or rotate a protector;
- encrypts each recovery password with the enrollment's public key (RSA-OAEP, SHA-256) before anything is written or sent. The machine holds no key that can decrypt them;
- writes the report to a queue folder readable only by SYSTEM and Administrators (`%ProgramData%\MSPAtlas\BitLocker\Queue`), then uploads queued reports oldest first over HTTPS and deletes each one once Atlas acknowledges it. If Atlas can't be reached the reports wait, up to 100;
- prints one line of counts for the RMM log: never a key, the token, or Windows's own error text.

**In Atlas.** `POST /api/bitlocker/ingest` takes the report. It accepts only a bearer token (no session, no cookies, and nothing from a browser), with failed attempts limited per address. Atlas then:

- checks the report's shape strictly, that it names this enrollment, that the enrollment isn't revoked and the machine isn't blocked, and that a one-device enrollment is still on its own machine;
- ignores a report it has already taken (a retry);
- decrypts each password and saves it to the client's vault **only if it is a real recovery password** (eight groups of six digits, each a multiple of 11). Anything else is counted as rejected and dropped;
- saves each key once. A key whose protector ID is already in the client's vault (typed in, or from the RMM custom field) isn't copied. When a machine gets a new key the old entry stays, because it may still open an older image or backup;
- records the machine's volume status, and matches the machine to an asset by serial number, then by name or hostname. The keys are linked to that asset and the status shows in a **BitLocker** panel on it;
- keeps the newest status: a report that arrives late (queued during an outage) still has its keys saved but doesn't overwrite a newer one.

Vault entries the collector makes are recorded as created by "BitLocker collector (*enrollment name*)", acting for the administrator who enrolled it.

## What it does not do

- **It doesn't prove which machine is reporting.** The machine ID, hostname, and serial number are what the machine says they are. Someone with an enrollment's script could report made-up status for that client, or upload keys of their own; they could not read anything from Atlas, reach another client, or decrypt keys already sent.
- **It isn't signed.** Run it through your RMM's own script store, and treat the file as a secret.
- **It doesn't schedule itself.** The RMM owns the schedule. Every 6 hours is plenty.
- **It doesn't remove anything.** A key no longer on a machine stays in the vault until someone archives it.

## Verification

- `bitlocker-collector-script.test.ts` runs the script's functions under Windows PowerShell 5.1 against made-up volumes (on Windows machines only), and checks Atlas can decrypt what PowerShell encrypted, that a locked volume is reported without leaking Windows's error text, and that the read-method allowlist refuses anything else.
- `bitlocker-collector.test.ts` covers enrollment, ingest, duplicates, late reports, bad tokens, browser requests, revocation, blocking, one-device binding, and that keys are stored only encrypted.

**Not yet done:** a run on a real machine through a real RMM, against real BitLocker volumes. Pilot it on one machine you can check by hand before rolling it out.
