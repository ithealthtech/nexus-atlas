import { z } from 'zod';

// ---------- favorites ----------
/** What can be starred for the dashboard. Passwords have their own favorites in the vault and are listed too. */
export const FAVORITE_TYPES = ['client', 'document', 'asset'] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];
export interface FavoriteItem {
  type: FavoriteType | 'password';
  id: string;
  name: string;
  /** The client it belongs to; null for a client itself and for knowledge base documents. */
  clientId: string | null;
  clientName: string | null;
}
export interface FavoriteState {
  favorite: boolean;
}

// ---------- dashboard layout ----------
/** Where a card sits: the full-width band at the top, the wide column, or the narrow side column. */
export type DashboardArea = 'top' | 'main' | 'side';
export const DASHBOARD_WIDGETS = [
  'stats',
  'rmm-health',
  'trackers',
  'tickets',
  'asset-stats',
  'health',
  'favorites',
  'pinned-reports',
  'recent-clients',
  'activity',
  'setup',
  'review',
  'coming-up',
  'domains',
  'warranty',
  'team-pulse',
] as const;
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];
export const DASHBOARD_WIDGET_INFO: Record<
  DashboardWidget,
  { label: string; description: string; area: DashboardArea }
> = {
  stats: { label: 'Totals', description: 'Clients, assets, documents, and password health.', area: 'top' },
  'rmm-health': { label: 'RMM health', description: 'Agents online, checking in, and protected.', area: 'top' },
  trackers: { label: 'Domain and SSL trackers', description: 'Domains and certificates by expiry.', area: 'top' },
  tickets: { label: 'Tickets', description: 'Open tickets from the ConnectWise platform.', area: 'top' },
  'asset-stats': { label: 'Asset statistics', description: 'Devices by kind and operating system.', area: 'top' },
  health: {
    label: 'Client health',
    description: 'Every client scored 0–100, lowest first, with its trend.',
    area: 'main',
  },
  favorites: {
    label: 'Favorites',
    description: 'Clients, documents, assets, and passwords you starred.',
    area: 'main',
  },
  'pinned-reports': {
    label: 'Pinned reports',
    description: 'Report templates you pinned, a click from running.',
    area: 'main',
  },
  'recent-clients': { label: 'Recently updated clients', description: 'The last five clients changed.', area: 'main' },
  activity: { label: 'Recent activity', description: 'The latest changes you can see.', area: 'main' },
  setup: { label: 'Get set up', description: 'First steps, until they are done.', area: 'side' },
  review: { label: 'Review queue', description: 'Documents flagged or past their review date.', area: 'side' },
  'coming-up': { label: 'Coming up', description: 'Anything expiring or due in 30 days.', area: 'side' },
  domains: { label: 'Domains and SSL', description: 'Domains and certificates expiring in 90 days.', area: 'side' },
  warranty: { label: 'Warranties', description: 'Assets by warranty status.', area: 'side' },
  'team-pulse': {
    label: 'Team pulse',
    description: 'What each person on the team changed this month, and their stale documents. Administrators only.',
    area: 'side',
  },
};

/** Client workspace sections a person can hide. The overview always shows. */
export const CLIENT_SECTIONS = [
  'assets',
  'documents',
  'passwords',
  'contacts',
  'locations',
  'checklists',
  'licenses',
  'reports',
  'map',
  'activity',
  'teams',
] as const;
export type ClientSection = (typeof CLIENT_SECTIONS)[number];

/** How the main menu is laid out. Each person chooses their own. */
export const MENU_STYLES = ['rail', 'sidebar', 'top'] as const;
export type MenuStyle = (typeof MENU_STYLES)[number];
export const MENU_STYLE_INFO: Record<MenuStyle, { label: string; description: string }> = {
  rail: {
    label: 'Rail and panel',
    description: 'Five areas down the left edge, with the pages of the one you’re in beside them.',
  },
  sidebar: {
    label: 'Sidebar',
    description: 'One short list of the pages you use every day, with administration a click away.',
  },
  top: {
    label: 'Top bar',
    description: 'Areas across the top, leaving the full width of the screen for the page.',
  },
};

export const workspacePrefsSchema = z.object({
  // Every card in the order shown. Cards left out (for example ones added in a later version) use the default.
  widgets: z
    .array(z.object({ id: z.enum(DASHBOARD_WIDGETS), visible: z.boolean() }))
    .max(DASHBOARD_WIDGETS.length)
    .refine((list) => new Set(list.map((w) => w.id)).size === list.length, 'Each card can appear once.'),
  hiddenSections: z.array(z.enum(CLIENT_SECTIONS)).max(CLIENT_SECTIONS.length),
  // Left out by the dashboard and section editors, which then keep whatever is saved.
  menu: z.enum(MENU_STYLES).optional(),
});
export type WorkspacePrefs = Omit<z.infer<typeof workspacePrefsSchema>, 'menu'> & {
  menu: MenuStyle;
  /** The newest "What's new" this person has seen or put away (see WHATS_NEW). Set through its own route. */
  seenWhatsNew?: string;
  /** Report templates pinned to the dashboard, in the order pinned. Set through its own route. */
  pinnedReports?: string[];
};

/** How many report templates one person can pin. */
export const MAX_PINNED_REPORTS = 8;
export const pinReportSchema = z.object({ templateId: z.string().uuid(), pinned: z.boolean() });

/** The release the What's new page describes. A person who hasn't seen it gets a card on their dashboard. */
export const WHATS_NEW = '2.0';

export const DEFAULT_WORKSPACE: WorkspacePrefs = {
  widgets: DASHBOARD_WIDGETS.map((id) => ({ id, visible: true })),
  hiddenSections: [],
  menu: 'rail',
};

/**
 * Saved preferences filled out to the full set: saved cards keep their order and visibility, cards the saved list
 * doesn't mention take their default place, and anything unrecognised (from an older or newer version) is dropped.
 */
export function resolveWorkspace(saved: unknown): WorkspacePrefs {
  const raw = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const known = new Set<string>(DASHBOARD_WIDGETS);
  const seen = new Set<string>();
  const widgets: WorkspacePrefs['widgets'] = [];
  for (const w of Array.isArray(raw.widgets) ? raw.widgets : []) {
    const { id, visible } = (w ?? {}) as { id?: unknown; visible?: unknown };
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    widgets.push({ id: id as DashboardWidget, visible: visible !== false });
  }
  for (const id of DASHBOARD_WIDGETS) if (!seen.has(id)) widgets.push({ id, visible: true });
  const sections = new Set<string>(CLIENT_SECTIONS);
  const hiddenSections = [
    ...new Set((Array.isArray(raw.hiddenSections) ? raw.hiddenSections : []).filter((s) => sections.has(s))),
  ] as ClientSection[];
  const menu = MENU_STYLES.includes(raw.menu as MenuStyle) ? (raw.menu as MenuStyle) : DEFAULT_WORKSPACE.menu;
  const whatsNew = typeof raw.seenWhatsNew === 'string' ? { seenWhatsNew: raw.seenWhatsNew } : {};
  const pins = Array.isArray(raw.pinnedReports)
    ? [...new Set(raw.pinnedReports.filter((id): id is string => typeof id === 'string'))].slice(0, MAX_PINNED_REPORTS)
    : [];
  return { widgets, hiddenSections, menu, ...whatsNew, ...(pins.length ? { pinnedReports: pins } : {}) };
}

// ---------- team pulse ----------
/** A document nobody has edited for this long counts as stale, for the team pulse. */
export const STALE_DOCUMENT_DAYS = 180;
/** How much each person on the team has documented lately, for administrators. */
export interface TeamPulse {
  days: number;
  people: {
    id: string;
    name: string;
    /** Changes recorded in the activity feed in the last `days` days, and in the `days` before that. */
    changes: number;
    previous: number;
    /** Clients they changed something for. */
    clients: number;
    /** Current documents they last edited that haven't been touched in STALE_DOCUMENT_DAYS: theirs to review. */
    stale: number;
    lastSignInAt: string | null;
  }[];
}

// ---------- client workspace ----------
/** Item counts beside each client section. Passwords is null when the viewer can't open the client's vault. */
export interface ClientCounts {
  assets: number;
  documents: number;
  passwords: number | null;
  contacts: number;
  locations: number;
  checklists: number;
}
