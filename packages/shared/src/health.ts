// ---------- client health score ----------
/**
 * A client's health, 0–100, from four parts weighted by how much they matter. A part with nothing to measure (no
 * RMM devices, say) is left out and the others count for more; it is never assumed healthy.
 */
export const HEALTH_PARTS = ['security', 'endpoints', 'documentation', 'renewals'] as const;
export type HealthPart = (typeof HEALTH_PARTS)[number];
export const HEALTH_PART_INFO: Record<HealthPart, { label: string; weight: number; description: string }> = {
  security: {
    label: 'Security',
    weight: 30,
    description: 'Passwords without issues, endpoint protection running, and disks encrypted.',
  },
  endpoints: { label: 'Endpoints', weight: 25, description: 'Devices online and checking in on time.' },
  documentation: {
    label: 'Documentation',
    weight: 25,
    description: 'The essentials on record, and documents reviewed on time.',
  },
  renewals: {
    label: 'Renewals',
    weight: 20,
    description: 'Domains, certificates, warranties, and subscriptions in date.',
  },
};

/** Something that lowers a score, and how many points fixing it would add to the client's overall score. */
export interface HealthFinding {
  text: string;
  /** Points the overall score would rise by if this were fixed. */
  gain: number;
  /** Where to fix it, under the client: '/passwords', '/assets', '/documents', '/contacts', and so on. */
  section: string;
}
export interface HealthPartScore {
  part: HealthPart;
  /** 0–100, or null when there was nothing to measure. */
  score: number | null;
  /** What was measured, in a few words. */
  detail: string;
  findings: HealthFinding[];
}
export interface ClientHealth {
  clientId: string;
  clientName: string;
  score: number | null;
  parts: HealthPartScore[];
  computedAt: string;
}
export interface ClientHealthDetail extends ClientHealth {
  /** One point per day recorded, oldest first. */
  trend: { day: string; score: number }[];
  /** Points up or down since about 30 days ago, or null without a score then. */
  change: number | null;
}
export interface ClientHealthSummary {
  clientId: string;
  clientName: string;
  score: number | null;
  change: number | null;
  /** The part pulling the score down most, for a one-word reason. */
  weakest: HealthPart | null;
  /** The last 30 days, oldest first. */
  trend: number[];
}

/** A client's score now and a week ago, for the owners' Monday email. */
export interface HealthWeek {
  clientId: string;
  clientName: string;
  score: number | null;
  /** The score about a week ago, or null without one then. */
  previous: number | null;
}

export type HealthTone = 'success' | 'primary' | 'warning' | 'danger' | 'neutral';
/** The words and colour for a score: Healthy, Good, Needs attention, At risk. */
export function healthGrade(score: number | null): { label: string; tone: HealthTone } {
  if (score === null) return { label: 'Not measured', tone: 'neutral' };
  if (score >= 90) return { label: 'Healthy', tone: 'success' };
  if (score >= 75) return { label: 'Good', tone: 'primary' };
  if (score >= 60) return { label: 'Needs attention', tone: 'warning' };
  return { label: 'At risk', tone: 'danger' };
}
