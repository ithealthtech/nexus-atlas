# Delivery roadmap

## 0.1 — local foundation (this slice)

Working documentation/asset workflows, local persistence, client boundaries, demo identities, search, revisions, relationships, audit events, exports, and the synthetic BitLocker module. Password and recovery-key storage remain disabled.

## 0.2 — real deployment foundation

- ✅ Local accounts with MFA, administrator bootstrap, roles, per-client grants, session lifecycle, and a security event log (first slice).
- Entra ID/OIDC sign-in, passkeys, groups, and finer-grained permissions (per record type, export rights).
- Choose the self-hosted Linux target.
- PostgreSQL repository/migrations and tenant isolation checks.
- Production configuration, HTTPS, health checks, backups and a restore drill.
- Import/export round trip and attachment authorization.

## 0.3 — reviewed vault and BitLocker pilot

- Approved vault threat model and key hierarchy.
- Encrypted collections, device enrollment, recovery, membership revocation, and audit.
- Port the imported RMM collector enrollment/ingress and browser recovery experience.
- Independent security review before real client credentials or recovery keys.

## Subsequent releases

Client portal publishing, SOP/checklist executions, asset templates, network/IPAM/racks, renewal alerts, PSA/RMM/Microsoft integrations, discovery/reconciliation, browser autofill, mobile/desktop clients, passkeys, offline synchronization, sharing, commercial cloud administration, and expanded vendor parity.

Full IT Glue/ITBoost/Hudu/Bitwarden parity is a longer product program. A capability is complete only when its workflow, permissions, failure behavior, recovery behavior, and validation evidence are present.
