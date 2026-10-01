import { z } from 'zod';
import type { RichText } from './docs.js';

// ---------- built-in template library: checklists and knowledge-base runbooks for common MSP work ----------
// Adding one copies it into the organization as an ordinary MSP checklist or knowledge-base document, which the
// team can then edit, run or archive like any other. The library itself never changes what was added.

export interface ChecklistTemplate {
  key: string;
  title: string;
  description: string;
  steps: string[];
}

/** A runbook's body: headings, paragraphs and lists, turned into a rich-text document when it's added. */
export type RunbookBlock = { h: string } | { p: string } | { ol: string[] } | { ul: string[] };
export interface RunbookTemplate {
  key: string;
  title: string;
  description: string;
  body: RunbookBlock[];
}

export interface TemplateView {
  key: string;
  kind: 'checklist' | 'runbook';
  title: string;
  description: string;
  /** Steps for a checklist, sections for a runbook. */
  size: number;
  /** The checklist or document made from it, while that still exists. */
  addedId: string | null;
}

export const addTemplatesSchema = z.object({
  /** Which templates to add; all of them when left out. Ones already added are skipped. */
  keys: z.array(z.string().max(60)).max(100).optional(),
});

export const CHECKLIST_TEMPLATES: ChecklistTemplate[] = [
  {
    key: 'client-onboarding',
    title: 'New client onboarding',
    description: 'Take on a new managed client: access, discovery, documentation and tooling.',
    steps: [
      'Signed agreement and scope of services filed',
      'Client created in Atlas with main contacts and locations',
      'Client and its contacts matched in the PSA',
      'Admin credentials collected and stored in the vault (domain, M365, firewall, registrar, ISP)',
      'Previous provider handover received and reviewed',
      'Network discovery run; networks and VLANs documented',
      'RMM agent deployed to every endpoint and server',
      'Endpoints reconciled in Atlas against the RMM device list',
      'Antivirus/EDR deployed and reporting',
      'Backups reviewed or set up, and a first test restore done',
      'Microsoft 365 tenant reviewed: admins, MFA, licensing, security defaults',
      'Domains, DNS host and SSL certificates documented with expiry dates',
      'Firewall, switches and wireless documented with management access',
      'Line-of-business applications and vendor contacts documented',
      'Patch policy assigned and first patch run completed',
      'Client onboarding call held; support process and contacts explained',
    ],
  },
  {
    key: 'client-offboarding',
    title: 'Client offboarding',
    description: 'End a managed client relationship cleanly and securely.',
    steps: [
      'Termination date and handover scope confirmed in writing',
      'Documentation and credentials export prepared for the client or incoming provider',
      'Handover meeting held with the client or incoming provider',
      'Our admin accounts removed from the client’s systems (M365, firewall, servers, registrar)',
      'Shared and vendor passwords the team knew rotated, or the client told to rotate them',
      'RMM agents uninstalled from all endpoints',
      'Antivirus/EDR and other licensed tools removed or transferred',
      'Backup jobs stopped; retained backups handed over or deleted as agreed',
      'Delegated partner access (GDAP) removed from the M365 tenant',
      'Recurring billing and licenses cancelled in the PSA',
      'Client archived in Atlas',
    ],
  },
  {
    key: 'user-onboarding',
    title: 'New user onboarding',
    description: 'Set up a new employee at a client: account, licensing, device and access.',
    steps: [
      'Request received with name, title, manager, start date and required access',
      'Account created in Active Directory / Entra ID',
      'Microsoft 365 license assigned and mailbox ready',
      'Added to security groups, distribution lists and Teams',
      'MFA registration set up (or temporary access pass issued)',
      'Line-of-business application accounts created',
      'Endpoint prepared and assigned to the user in Atlas',
      'Shared drives, printers and VPN access confirmed',
      'Phone/extension set up if needed',
      'Contact added in Atlas',
      'Credentials handed over securely and the user signed in on day one',
    ],
  },
  {
    key: 'user-offboarding',
    title: 'User offboarding',
    description: 'Remove a departing employee’s access and preserve their data.',
    steps: [
      'Request confirmed by an authorized client contact, with the departure date and time',
      'Account disabled and sign-in blocked at the agreed time',
      'All sessions revoked and MFA methods removed',
      'Password reset',
      'Mailbox converted to shared or forwarded, as the client asked',
      'OneDrive/files transferred to the manager',
      'Removed from groups, distribution lists and Teams',
      'Line-of-business application and VPN accounts disabled',
      'Shared passwords the user knew rotated',
      'Company devices collected and wiped or reassigned in Atlas',
      'Licenses removed or reassigned',
      'Contact archived in Atlas',
    ],
  },
  {
    key: 'endpoint-setup',
    title: 'New endpoint setup',
    description: 'Deploy a new PC, Mac or server to a client’s standard.',
    steps: [
      'Hardware received; serial number and warranty recorded in Atlas Endpoints',
      'Operating system installed or reset to the client’s standard image',
      'Joined to the domain / enrolled in Intune or Entra ID',
      'All operating system and driver updates installed',
      'RMM agent installed and the device showing in RMM',
      'Antivirus/EDR installed and reporting',
      'Disk encryption enabled (BitLocker/FileVault) and the recovery key stored',
      'Standard and user-specific applications installed',
      'Local admin password managed (LAPS) or stored in the vault',
      'Backup configured where the device needs one',
      'Assigned to the user and location in Atlas',
      'User signed in and checked email, files and printing',
    ],
  },
  {
    key: 'endpoint-decommission',
    title: 'Endpoint decommission',
    description: 'Retire a PC, Mac or server and dispose of it safely.',
    steps: [
      'Decommission approved by the client',
      'User data and anything still needed backed up or migrated',
      'Removed from the domain, Intune/Entra ID and Autopilot',
      'RMM agent and antivirus/EDR uninstalled; licenses freed',
      'Removed from backup jobs and monitoring',
      'Drive securely wiped, or removed and destroyed',
      'Certificate of destruction filed if required',
      'DNS, DHCP reservations and firewall rules for it removed',
      'Endpoint archived in Atlas with the disposal date',
    ],
  },
  {
    key: 'server-patching',
    title: 'Server patching',
    description: 'Monthly patch run for a client’s servers.',
    steps: [
      'Maintenance window confirmed with the client',
      'Pending updates reviewed; known-bad patches held back',
      'Latest backup or snapshot verified before patching',
      'Updates installed on non-critical servers first',
      'Servers rebooted in dependency order (domain controllers last, one at a time)',
      'Services, shares and applications checked after reboot',
      'Event logs checked for new errors',
      'Failed or deferred updates noted with the reason',
      'Client told the window is complete',
    ],
  },
  {
    key: 'backup-verification',
    title: 'Backup verification',
    description: 'Prove a client’s backups work, not just that the jobs ran.',
    steps: [
      'Every backup job’s recent results reviewed; failures and warnings explained',
      'Every critical server and dataset confirmed covered',
      'Retention and off-site/cloud copies checked against the agreed policy',
      'Test restore of files done and the files opened',
      'Test boot or full restore of one server done (quarterly)',
      'Microsoft 365 backup (mail, OneDrive, SharePoint) checked',
      'Backup storage capacity checked',
      'Results and restore times recorded in Atlas',
    ],
  },
  {
    key: 'm365-setup',
    title: 'Microsoft 365 and email setup',
    description: 'Stand up a new Microsoft 365 tenant or bring an existing one to standard.',
    steps: [
      'Tenant created or delegated partner access (GDAP) granted',
      'Global admin credentials stored in the vault; break-glass account created',
      'Custom domain added and verified',
      'DNS records added: MX, SPF, DKIM, DMARC and autodiscover',
      'MFA enforced (security defaults or Conditional Access)',
      'Legacy authentication blocked',
      'Licenses assigned and mailboxes created',
      'Mail migrated from the old system, if any',
      'Anti-phishing, anti-spam and safe links/attachments policies set',
      'Audit logging and mailbox auditing on',
      'Microsoft 365 backup configured',
      'Tenant details documented in Atlas',
    ],
  },
  {
    key: 'firewall-change',
    title: 'Firewall change',
    description: 'Make a planned firewall or network rule change safely.',
    steps: [
      'Change requested and approved, with the business reason recorded',
      'Current configuration backed up',
      'Change and rollback plan written down',
      'Maintenance window agreed if the change could interrupt service',
      'Change made',
      'Change tested from inside and outside the network',
      'Rule commented with the ticket number and date',
      'Configuration backed up again and stored',
      'Atlas documentation updated',
    ],
  },
  {
    key: 'password-rotation',
    title: 'Password rotation',
    description: 'Rotate a client’s privileged and shared credentials.',
    steps: [
      'Credentials due for rotation listed from the vault',
      'Domain and Microsoft 365 admin passwords rotated',
      'Service account passwords rotated and dependent services restarted',
      'Firewall, switch and wireless admin passwords rotated',
      'Local admin passwords rotated (or LAPS confirmed working)',
      'Shared vendor and application passwords rotated',
      'Vault entries updated with the new passwords',
      'Everything that uses the changed credentials checked',
    ],
  },
  {
    key: 'incident-response',
    title: 'Security incident response',
    description: 'First steps for a suspected compromise, malware or ransomware.',
    steps: [
      'Incident logged with the time, who reported it and what was seen',
      'Client’s decision-maker and our escalation contact notified',
      'Affected devices isolated from the network (EDR isolate or unplug)',
      'Compromised accounts disabled and sessions revoked',
      'Evidence preserved: logs, screenshots, suspicious files',
      'Scope determined: which users, devices and data are affected',
      'Cyber insurance carrier contacted if the client has a policy',
      'Threat removed and affected systems cleaned or rebuilt',
      'Credentials that may be exposed rotated',
      'Data restored from known-good backups if needed',
      'Monitoring increased while recovering',
      'Legal or regulatory notification decided with the client',
      'Post-incident review written and lessons recorded in Atlas',
    ],
  },
  {
    key: 'ssl-domain-renewal',
    title: 'SSL certificate and domain renewal',
    description: 'Renew a certificate or domain before it expires.',
    steps: [
      'Expiring certificate or domain found on the Expirations page',
      'Renewal approved by the client if it costs money',
      'Domain renewed at the registrar, or auto-renew confirmed',
      'Certificate request generated and the new certificate issued',
      'New certificate installed on every server, firewall and appliance that uses it',
      'Services restarted and the new certificate checked in a browser',
      'Expiry dates updated in Atlas',
    ],
  },
];

export const RUNBOOK_TEMPLATES: RunbookTemplate[] = [
  {
    key: 'runbook-incident-response',
    title: 'Security incident response runbook',
    description: 'What to do in the first hours of a suspected breach or ransomware attack.',
    body: [
      {
        p: 'Use this when a client reports, or monitoring shows, a possible compromise: ransomware, a phished account, unexpected admin activity or malware. Speed matters more than perfect notes, but write down the time of every action.',
      },
      { h: 'Severity' },
      {
        ul: [
          'Critical: ransomware, data being exfiltrated, or a domain/global admin compromised. Escalate immediately.',
          'High: a user account compromised or malware on one device.',
          'Medium: a suspicious email or alert with no sign it worked.',
        ],
      },
      { h: 'Contain' },
      {
        ol: [
          'Isolate affected devices with EDR, or disconnect them from the network. Do not power them off; memory is evidence.',
          'Disable compromised accounts, reset their passwords and revoke all sessions.',
          'If ransomware is spreading, disconnect backup storage and block internet access at the firewall.',
          'Notify the client’s decision-maker and our escalation contact.',
        ],
      },
      { h: 'Investigate' },
      {
        ol: [
          'Collect sign-in logs, mailbox rules, EDR alerts and firewall logs for the affected period.',
          'Work out the first point of entry and every account and device touched.',
          'If the client has cyber insurance, call the carrier before cleaning up; they may require their own responders.',
        ],
      },
      { h: 'Recover' },
      {
        ol: [
          'Rebuild or clean affected systems, then restore data from backups taken before the compromise.',
          'Rotate every credential that may have been exposed, including service accounts.',
          'Keep extra monitoring in place for at least two weeks.',
        ],
      },
      { h: 'Afterwards' },
      {
        ul: [
          'Write a post-incident review: timeline, cause, impact and what changes.',
          'Decide with the client on legal or regulatory notifications.',
          'Run the Security incident response checklist for the client to record each step.',
        ],
      },
    ],
  },
  {
    key: 'runbook-backup-restore',
    title: 'Backup restore runbook',
    description: 'How to restore files, a mailbox or a whole server from backup.',
    body: [
      {
        p: 'Before restoring, confirm what was lost, when it was last known good, and where it should go back to. Never restore over live data without a copy of what is there now.',
      },
      { h: 'Files and folders' },
      {
        ol: [
          'Find the backup point from just before the loss.',
          'Restore to an alternate location first, then check the files open.',
          'Move the restored files into place and confirm with the user.',
        ],
      },
      { h: 'Microsoft 365 mail, OneDrive or SharePoint' },
      {
        ol: [
          'Check the recycle bins and Recoverable Items first; they may hold what is needed.',
          'Otherwise restore from the Microsoft 365 backup to the original location or a restore folder.',
        ],
      },
      { h: 'Whole server' },
      {
        ol: [
          'Tell the client how long the restore is expected to take and what will be offline.',
          'Restore to the original hardware, new hardware or a virtual machine, as the backup product allows.',
          'Start services in dependency order and check applications, shares and printing.',
          'Restart backups on the restored server and confirm the next job succeeds.',
        ],
      },
      { h: 'Record it' },
      {
        p: 'Note in Atlas what was restored, from which backup point, and how long it took. Real restore times are the best evidence for the client’s recovery plan.',
      },
    ],
  },
  {
    key: 'runbook-server-patching',
    title: 'Server patching runbook',
    description: 'The standard monthly patch process and what to do when a patch goes wrong.',
    body: [
      {
        p: 'Servers are patched monthly in an agreed maintenance window. Workstations are patched automatically by RMM policy.',
      },
      { h: 'Before the window' },
      {
        ul: [
          'Check the month’s release notes and known issues; hold back any patch with reported problems.',
          'Confirm last night’s backup or take a snapshot.',
          'Remind the client of the window the day before.',
        ],
      },
      { h: 'Order of servers' },
      {
        ol: [
          'Non-critical and test servers.',
          'Application and file servers.',
          'Database servers, after stopping their applications.',
          'Domain controllers, one at a time, waiting for each to come back before the next.',
          'Hypervisor hosts last, after their virtual machines are shut down or moved.',
        ],
      },
      { h: 'If something breaks' },
      {
        ol: [
          'Uninstall the update that caused it, or revert the snapshot.',
          'Pause that update in RMM for the client.',
          'Record the patch number and symptoms so other clients are not hit.',
        ],
      },
    ],
  },
  {
    key: 'runbook-firewall-change',
    title: 'Firewall change runbook',
    description: 'How network and firewall changes are requested, made and rolled back.',
    body: [
      {
        p: 'Every firewall change has a reason, an approval and a way back. Unplanned changes during an outage are fine, but get the same write-up afterwards.',
      },
      { h: 'Standard change' },
      {
        ol: [
          'Record the request and who approved it in the ticket.',
          'Export and save the current configuration.',
          'Write the exact change and the rollback steps.',
          'Make the change, adding a comment with the ticket number to every rule touched.',
          'Test from inside and outside the network, including the services the change was for.',
          'Save the new configuration and update the client’s network documentation in Atlas.',
        ],
      },
      { h: 'Rules we never add without a second review' },
      {
        ul: [
          'Inbound any-to-any, or management interfaces exposed to the internet.',
          'Inbound RDP or SMB from the internet.',
          'Disabling security services (IPS, web filtering, geo-blocking) for a whole network.',
        ],
      },
      { h: 'Rollback' },
      {
        p: 'If a change breaks service and the fix isn’t obvious within 15 minutes, restore the saved configuration and investigate afterwards.',
      },
    ],
  },
  {
    key: 'runbook-credential-compromise',
    title: 'Compromised account runbook',
    description: 'Respond to a phished or compromised Microsoft 365 or domain account.',
    body: [
      {
        p: 'Signs: impossible-travel sign-ins, new inbox rules, the user’s contacts receiving phishing, or MFA prompts the user didn’t start.',
      },
      { h: 'Immediately' },
      {
        ol: [
          'Block sign-in and revoke all sessions for the account.',
          'Reset the password and remove MFA methods the user doesn’t recognise.',
          'Remove inbox rules, forwarding and delegates the attacker added.',
          'Check for new app registrations, consented apps and OAuth grants.',
        ],
      },
      { h: 'Scope' },
      {
        ul: [
          'Review sign-in and audit logs for what the attacker accessed.',
          'Search sent mail for phishing sent from the account and warn recipients.',
          'Check whether any shared or vault passwords the user could see need rotating.',
        ],
      },
      { h: 'Restore access' },
      {
        p: 'Have the user re-register MFA in person or over a verified phone call, then sign in. If an admin account was involved, treat it as a full security incident.',
      },
    ],
  },
  {
    key: 'runbook-cert-domain-renewal',
    title: 'Certificate and domain renewal runbook',
    description: 'Keep certificates and domains from expiring and replace them cleanly.',
    body: [
      {
        p: 'Atlas lists upcoming expiries on the Expirations page and can email reminders. Start renewals at least 30 days ahead.',
      },
      { h: 'Domains' },
      {
        ol: [
          'Confirm with the client that the domain is still wanted.',
          'Renew at the registrar or confirm auto-renew and the card on file.',
          'Make sure registrar credentials are in the vault and the contact email is monitored.',
        ],
      },
      { h: 'Certificates' },
      {
        ol: [
          'List everywhere the certificate is installed: web servers, firewalls/VPN, mail, appliances, load balancers.',
          'Issue the new certificate (or renew it through ACME where supported).',
          'Install it everywhere on the list and restart the services that use it.',
          'Check each service in a browser or with a certificate checker.',
          'Update the expiry date in Atlas.',
        ],
      },
    ],
  },
];

const text = (value: string) => [{ type: 'text', text: value }];
const list = (type: 'bulletList' | 'orderedList', items: string[]) => ({
  type,
  ...(type === 'orderedList' && { attrs: { start: 1 } }),
  content: items.map((i) => ({ type: 'listItem', content: [{ type: 'paragraph', content: text(i) }] })),
});

/** A runbook's body as the editor's rich text. */
export function runbookContent(body: RunbookBlock[]): RichText {
  return {
    type: 'doc',
    content: body.map((b) =>
      'h' in b
        ? { type: 'heading', attrs: { level: 2 }, content: text(b.h) }
        : 'p' in b
          ? { type: 'paragraph', content: text(b.p) }
          : 'ol' in b
            ? list('orderedList', b.ol)
            : list('bulletList', b.ul),
    ),
  };
}
