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
}
export interface ClientSummary {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'prospect' | 'inactive';
  notes: string;
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
