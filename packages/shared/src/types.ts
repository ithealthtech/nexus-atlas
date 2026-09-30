import type { AccessLevel, Role } from './access.js';

export type SessionStage = 'mfa' | 'password' | 'mfa-setup' | 'active';
export interface Actor {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  mfa: boolean;
  /** Level granted for every client (admins: edit_passwords). */
  allClients: AccessLevel;
}
export interface SessionView {
  actor: Actor;
  csrf: string;
  stage: SessionStage;
  organization: { id: string; name: string };
  /** Second-step options, sent while the session is at the "mfa" stage. */
  methods?: { totp: boolean; passkey: boolean };
}
export interface ClientSummary {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'prospect' | 'inactive';
  /** Quick notes, shown at the top of the client workspace. */
  notes: string;
  /** Starts at 0 (never edited); each change to the notes adds one. */
  notesVersion: number;
  notesUpdatedAt: string | null;
  notesUpdatedByName: string | null;
  /** Hours of operation and maintenance window, as free text ("Mon–Fri 8–5", "Sundays 22:00–02:00"). */
  hours: string;
  maintenanceWindow: string;
  requireRevealReason: boolean;
  access: AccessLevel;
  createdAt: string;
  updatedAt: string;
}
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  allClients: AccessLevel;
  grants: { clientId: string; level: AccessLevel }[];
  mfa: boolean;
  disabled: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  /** Microsoft Entra ID: linked, or matched by email and waiting for an administrator to confirm. */
  entra: 'linked' | 'pending' | null;
  /** The Microsoft account waiting for confirmation: what it claimed, and its account ID to check against. */
  entraPending: { oid: string; email: string; name: string } | null;
  lastLoginAt: string | null;
  createdAt: string;
}
export interface SecurityEventView {
  id: string;
  actor: string;
  action: string;
  detail: string;
  ip: string;
  createdAt: string;
}
export interface ApiError {
  error: string;
  code?: string;
  fields?: Record<string, string>;
}
