// Roles and per-client access levels. The server enforces these; the UI uses them only to hide controls.
export const ROLES = ['owner', 'admin', 'technician', 'readonly_technician', 'client_editor', 'client_viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ACCESS_LEVELS = ['none', 'read', 'edit', 'edit_passwords'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ROLE_INFO: Record<
  Role,
  { label: string; description: string; staff: boolean; cap: AccessLevel; admin: boolean }
> = {
  owner: {
    label: 'Owner',
    description: 'Everything, including security settings and key management.',
    staff: true,
    cap: 'edit_passwords',
    admin: true,
  },
  admin: {
    label: 'Administrator',
    description: 'All clients, passwords, users, and settings.',
    staff: true,
    cap: 'edit_passwords',
    admin: true,
  },
  technician: {
    label: 'Technician',
    description: 'Works in the clients they are given, up to editing passwords.',
    staff: true,
    cap: 'edit_passwords',
    admin: false,
  },
  readonly_technician: {
    label: 'Read-only technician',
    description: 'Reads documentation for their clients. Cannot change anything.',
    staff: true,
    cap: 'read',
    admin: false,
  },
  client_editor: {
    label: 'Client editor',
    description: 'A client contact who can edit their own documentation.',
    staff: false,
    cap: 'edit',
    admin: false,
  },
  client_viewer: {
    label: 'Client viewer',
    description: 'A client contact with read-only access to their documentation.',
    staff: false,
    cap: 'read',
    admin: false,
  },
};

export const LEVEL_INFO: Record<AccessLevel, { label: string; rank: number }> = {
  none: { label: 'No access', rank: 0 },
  read: { label: 'Read', rank: 1 },
  edit: { label: 'Edit', rank: 2 },
  edit_passwords: { label: 'Edit + passwords', rank: 3 },
};

export const levelRank = (level: AccessLevel) => LEVEL_INFO[level].rank;
export const maxLevel = (...levels: AccessLevel[]): AccessLevel =>
  levels.reduce<AccessLevel>((best, level) => (levelRank(level) > levelRank(best) ? level : best), 'none');
export const minLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (levelRank(a) <= levelRank(b) ? a : b);
export const atLeast = (level: AccessLevel, required: AccessLevel) => levelRank(level) >= levelRank(required);
