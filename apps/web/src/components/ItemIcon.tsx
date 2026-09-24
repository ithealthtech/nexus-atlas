import { createElement } from 'react';
import {
  AppWindow,
  BadgeCheck,
  BookOpen,
  Box,
  Building2,
  Globe,
  Handshake,
  HardDriveDownload,
  KeyRound,
  Mail,
  MapPin,
  MonitorSmartphone,
  Network,
  Printer,
  Router,
  Server,
  ShieldCheck,
  User,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { ItemRef } from '@atlas/shared';
import { cn } from '@/lib/cn';

// Icons available to asset layouts. Unknown names fall back to a box.
export const LAYOUT_ICONS: Record<string, LucideIcon> = {
  server: Server,
  network: Network,
  globe: Globe,
  'shield-check': ShieldCheck,
  'badge-check': BadgeCheck,
  'app-window': AppWindow,
  'hard-drive-download': HardDriveDownload,
  mail: Mail,
  router: Router,
  wifi: Wifi,
  printer: Printer,
  handshake: Handshake,
  'monitor-smartphone': MonitorSmartphone,
  'key-round': KeyRound,
  box: Box,
};
export const layoutIcon = (name: string) => LAYOUT_ICONS[name] ?? Box;

const TYPE_ICONS: Record<ItemRef['type'], LucideIcon> = {
  asset: Server,
  document: BookOpen,
  contact: User,
  location: MapPin,
  client: Building2,
  password: KeyRound,
};
const TYPE_TONES: Record<ItemRef['type'], string> = {
  password: 'bg-warning-soft text-warning',
  asset: 'bg-info-soft text-info',
  document: 'bg-primary-soft text-primary',
  contact: 'bg-warning-soft text-warning',
  location: 'bg-success-soft text-success',
  client: 'bg-surface-3 text-text-2',
};

export function ItemIcon({ type, icon, className }: { type: ItemRef['type']; icon?: string; className?: string }) {
  // Icons come from fixed maps; createElement keeps React from treating them as components defined during render.
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', TYPE_TONES[type], className)} aria-hidden>
      {createElement(icon ? layoutIcon(icon) : TYPE_ICONS[type], { className: 'size-4' })}
    </span>
  );
}

/** Where an item lives in the app. */
export function itemHref(item: Pick<ItemRef, 'type' | 'id' | 'clientId'>): string {
  switch (item.type) {
    case 'asset':
      return `/assets/${item.id}`;
    case 'document':
      return `/documents/${item.id}`;
    case 'contact':
      return `/clients/${item.clientId}/contacts`;
    case 'location':
      return `/clients/${item.clientId}/locations`;
    case 'client':
      return `/clients/${item.id}`;
    case 'password':
      return `/passwords/${item.id}`;
  }
}
