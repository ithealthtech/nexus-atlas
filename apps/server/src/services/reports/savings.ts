import type { MicrosoftLicenseView } from '@atlas/shared';
import { microsoftListPrice } from '../m365-prices.js';
import type { Collector } from './context.js';
import { microsoftInventory } from './licenses.js';

/** A subscription tracked in Atlas: seats bought, how many are assigned, and what a seat costs per billing period. */
export interface TrackedSubscription {
  name: string;
  status: string;
  seats: number;
  /** Assignments recorded in Atlas; none recorded means unused seats can't be told. */
  assigned: number;
  unitCostCents: number;
  currency: string;
  billingCycle: string;
  renewalDate: string | null;
  autoRenew: boolean;
}
export interface Price {
  /** Per seat per month, or null when not known. */
  cents: number | null;
  currency: string;
  /** Where the price came from. */
  basis: 'tracked' | 'list' | 'unknown';
}
export interface UnusedSeats {
  subscription: string;
  source: 'Tracked' | 'Microsoft 365';
  seats: number;
  assigned: number;
  unused: number;
  price: Price;
}
export interface BlockedAccount {
  name: string;
  upn: string;
  subscriptions: string[];
  /** Per month in US dollars at list price, or null when a subscription isn't priced. */
  price: Price;
}
export interface Renewal {
  subscription: string;
  date: string;
  seats: number;
  /** Unused seats, or null when assignments aren't recorded. */
  unused: number | null;
  /** What the renewal costs for one billing period. */
  valueCents: number;
  currency: string;
  autoRenew: boolean;
}
export interface Savings {
  unused: UnusedSeats[];
  blocked: BlockedAccount[];
  renewals: Renewal[];
  /** Active tracked subscriptions with no assignments recorded, so their unused seats can't be counted. */
  untracked: number;
}

/** A tracked subscription's price per seat per month, or null for one-time purchases. */
const monthly = (s: TrackedSubscription): number | null =>
  s.billingCycle === 'monthly' ? s.unitCostCents : s.billingCycle === 'annual' ? s.unitCostCents / 12 : null;

/**
 * What a client is paying for and not using, from its tracked subscriptions and its Microsoft 365 tenant:
 * - unused seats (tracked ones only where assignments are recorded, so nothing is guessed);
 * - Microsoft licenses held by accounts whose sign-in is blocked, often people who have left;
 * - subscriptions renewing between today and `until`, with what each costs, to cut before they renew.
 * A Microsoft subscription is priced from a tracked subscription of the same name when there is one, otherwise at
 * Microsoft's list price, otherwise not at all.
 */
export function findSavings(
  tracked: TrackedSubscription[],
  microsoft: MicrosoftLicenseView | null,
  today: string,
  until: string,
): Savings {
  const active = tracked.filter((s) => s.status === 'active');
  const priceOf = (name: string, part: string): Price => {
    const own = active.find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase() && monthly(s) !== null);
    if (own) return { cents: monthly(own), currency: own.currency, basis: 'tracked' };
    const list = microsoftListPrice(part);
    return list === null
      ? { cents: null, currency: 'USD', basis: 'unknown' }
      : { cents: list, currency: 'USD', basis: 'list' };
  };

  const unused: UnusedSeats[] = [];
  const blocked: BlockedAccount[] = [];
  // A product Microsoft reports is counted from Microsoft's live assignments, not from the tracked copy of it.
  const reported = new Set(microsoft?.skus.map((sku) => sku.name.trim().toLowerCase()) ?? []);
  if (microsoft) {
    const skus = new Map(microsoft.skus.map((sku) => [sku.id.toLowerCase(), sku]));
    for (const sku of microsoft.skus)
      if (sku.status === 'Enabled' && sku.enabled > sku.assigned)
        unused.push({
          subscription: sku.name,
          source: 'Microsoft 365',
          seats: sku.enabled,
          assigned: sku.assigned,
          unused: sku.enabled - sku.assigned,
          price: priceOf(sku.name, sku.part),
        });
    for (const user of microsoft.users.filter((u) => !u.enabled && u.skuIds.length)) {
      const held = user.skuIds.map((id) => skus.get(id)).filter((sku) => sku !== undefined);
      if (!held.length) continue;
      const prices = held.map((sku) => priceOf(sku.name, sku.part));
      const currencies = new Set(prices.map((p) => p.currency));
      blocked.push({
        name: user.name,
        upn: user.upn,
        subscriptions: held.map((sku) => sku.name),
        price:
          prices.every((p) => p.cents !== null) && currencies.size === 1
            ? {
                cents: prices.reduce((n, p) => n + p.cents!, 0),
                currency: prices[0]!.currency,
                basis: prices.some((p) => p.basis === 'list') ? 'list' : 'tracked',
              }
            : { cents: null, currency: 'USD', basis: 'unknown' },
      });
    }
  }
  for (const s of active)
    if (s.assigned > 0 && s.seats > s.assigned && monthly(s) !== null && !reported.has(s.name.trim().toLowerCase()))
      unused.push({
        subscription: s.name,
        source: 'Tracked',
        seats: s.seats,
        assigned: s.assigned,
        unused: s.seats - s.assigned,
        price: { cents: monthly(s), currency: s.currency, basis: 'tracked' },
      });
  const renewals: Renewal[] = active
    .filter((s) => s.renewalDate && s.renewalDate >= today && s.renewalDate <= until)
    .map((s) => ({
      subscription: s.name,
      date: s.renewalDate!,
      seats: s.seats,
      unused: s.assigned ? Math.max(0, s.seats - s.assigned) : null,
      valueCents: s.unitCostCents * s.seats,
      currency: s.currency,
      autoRenew: s.autoRenew,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    unused: unused.sort((a, b) => (b.price.cents ?? 0) * b.unused - (a.price.cents ?? 0) * a.unused),
    blocked,
    renewals,
    untracked: active.filter((s) => s.seats > 0 && !s.assigned).length,
  };
}

/** Sums amounts per currency, so dollars and euros are never added together. */
class Totals {
  private readonly by = new Map<string, number>();
  add(cents: number | null, currency: string, times = 1) {
    if (cents) this.by.set(currency, (this.by.get(currency) ?? 0) + cents * times);
    return this;
  }
  text(times = 1) {
    if (!this.by.size) return 'None';
    return [...this.by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, cents]) => money(cents * times, currency))
      .join(' + ');
  }
}
const money = (cents: number, currency: string) =>
  `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const priced = (price: Price, times = 1) =>
  price.cents === null
    ? 'Not priced'
    : `${money(price.cents * times, price.currency)}${price.basis === 'list' ? ' (list)' : ''}`;

/** Unused seats, licenses on blocked accounts, and renewals to cut before they renew, priced per month. */
export const savings: Collector = async (report) => {
  const { today, cutoff } = report;
  const tracked = await report.licenses();
  const inventory = report.definition.includeMicrosoft ? await microsoftInventory(report) : new Map();
  if (!report.definition.includeMicrosoft) report.warn('Microsoft 365 was left out of this report.');
  const found = new Map(
    report.clients.map((c) => [
      c.id,
      findSavings(
        tracked
          .filter((l) => l.clientId === c.id)
          .map((l) => ({ ...l, assigned: l.assignments.length, renewalDate: l.renewalDate ?? null })),
        inventory.get(c.id) ?? null,
        today,
        cutoff,
      ),
    ]),
  );

  report.section(
    'Savings summary',
    ['Client', 'Seats to reclaim', 'Monthly waste', 'Yearly waste', 'Renewals due', 'Renewal value'],
    report.clients.map((c) => {
      const s = found.get(c.id)!;
      const waste = new Totals();
      for (const u of s.unused) waste.add(u.price.cents, u.price.currency, u.unused);
      for (const b of s.blocked) waste.add(b.price.cents, b.price.currency);
      const renewing = new Totals();
      for (const r of s.renewals) renewing.add(r.valueCents, r.currency);
      return [
        c.name,
        String(s.unused.reduce((n, u) => n + u.unused, 0) + s.blocked.reduce((n, b) => n + b.subscriptions.length, 0)),
        waste.text(),
        waste.text(12),
        String(s.renewals.length),
        renewing.text(),
      ];
    }),
  );
  report.section(
    'Unused seats',
    ['Client', 'Subscription', 'Source', 'Seats', 'Assigned', 'Unused', 'Price / seat / month', 'Monthly waste'],
    report.clients.flatMap((c) =>
      found
        .get(c.id)!
        .unused.map((u) => [
          c.name,
          u.subscription,
          u.source,
          String(u.seats),
          String(u.assigned),
          String(u.unused),
          priced(u.price),
          priced(u.price, u.unused),
        ]),
    ),
  );
  if (inventory.size)
    report.section(
      'Licenses on blocked accounts',
      ['Client', 'Account', 'Subscriptions', 'Monthly cost'],
      report.clients.flatMap((c) =>
        found.get(c.id)!.blocked.map((b) => [c.name, b.upn || b.name, b.subscriptions.join(', '), priced(b.price)]),
      ),
    );
  report.section(
    `Renewals through ${cutoff}`,
    ['Client', 'Subscription', 'Renewal', 'Seats', 'Unused', 'Renewal value', 'Auto-renew', 'Before it renews'],
    report.clients.flatMap((c) =>
      found
        .get(c.id)!
        .renewals.map((r) => [
          c.name,
          r.subscription,
          r.date,
          String(r.seats),
          r.unused === null ? 'Not recorded' : String(r.unused),
          money(r.valueCents, r.currency),
          r.autoRenew ? 'Yes' : 'No',
          r.unused
            ? `Cut ${r.unused} unused ${r.unused === 1 ? 'seat' : 'seats'}: saves ${money((r.valueCents / r.seats) * r.unused, r.currency)} a term`
            : r.autoRenew
              ? 'Renews by itself: confirm it is still needed'
              : 'Renew or cancel',
        ]),
    ),
  );

  report.source(
    'Atlas subscriptions',
    'Tracked subscriptions with their seats, assignments, unit costs and renewal dates.',
  );
  if (inventory.size)
    report.warn(
      'Microsoft 365 seats are priced from a tracked subscription of the same name, or else estimated at Microsoft’s published list price in US dollars with an annual commitment, marked “(list)”. Your price may differ.',
    );
  if ([...found.values()].some((s) => s.blocked.length))
    report.warn(
      'Blocked accounts often belong to people who have left. Remove their licenses, or convert their mailbox to a shared mailbox, which needs no license under 50 GB.',
    );
  const untracked = [...found.values()].reduce((n, s) => n + s.untracked, 0);
  if (untracked)
    report.warn(
      `${untracked} tracked ${untracked === 1 ? 'subscription has' : 'subscriptions have'} no assignments recorded, so ${untracked === 1 ? 'its' : 'their'} unused seats aren’t counted. Record who uses each seat to include them.`,
    );
};
