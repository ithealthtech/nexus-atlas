import { z } from 'zod';
import type { AccessLevel, Role } from './access.js';

// ---------- access reviews ----------
/** How often a client's access should be reviewed; older than this, its card says a review is due. */
export const ACCESS_REVIEW_DAYS = 90;

/** What the reviewer decided about one person: their access stays, or it goes. */
export type AccessDecision = 'keep' | 'remove';

/** One person with access to the client when the review started, and the reviewer's decision. */
export interface AccessReviewItem {
  userId: string;
  name: string;
  email: string;
  role: Role;
  level: AccessLevel;
  /** Where the access comes from: "Direct", "Group: Technicians", "All clients". */
  via: string[];
  mfa: boolean;
  lastLoginAt: string | null;
  decision: AccessDecision | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** After a removal: whether they can still open the client through a group or the all-clients level. */
  stillHasAccess?: boolean;
}

export interface AccessReviewView {
  id: string;
  clientId: string;
  clientName: string;
  items: AccessReviewItem[];
  startedByName: string;
  createdAt: string;
  completedAt: string | null;
  signedName: string | null;
}

export const accessDecisionSchema = z.object({
  userId: z.string().uuid(),
  decision: z.enum(['keep', 'remove']),
});
export const signOffSchema = z.object({
  signedName: z.string().trim().min(2, 'Type your name to sign the review off.').max(120),
});
