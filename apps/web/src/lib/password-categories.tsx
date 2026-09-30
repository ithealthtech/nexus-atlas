import {
  AppWindow,
  Building2,
  Cloud,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Mail,
  MonitorSmartphone,
  Network,
  Printer,
  Server,
  StickyNote,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { PASSWORD_CATEGORY_LABELS, type PasswordCategory, type PasswordView } from '@atlas/shared';

export const CATEGORY_ICONS: Record<PasswordCategory, LucideIcon> = {
  domain: Building2,
  cloud: Cloud,
  email: Mail,
  network: Network,
  wifi: Wifi,
  server: Server,
  database: Database,
  remote: MonitorSmartphone,
  application: AppWindow,
  vendor: Globe,
  website: Globe,
  device: Printer,
  other: KeyRound,
};

export function PasswordIcon({
  item,
  className,
}: {
  item: Pick<PasswordView, 'kind' | 'category'>;
  className?: string;
}) {
  const Icon =
    item.kind === 'bitlocker' ? HardDrive : item.kind === 'note' ? StickyNote : CATEGORY_ICONS[item.category];
  return <Icon className={className} aria-hidden />;
}

/** The type filter's value for an entry: its kind, or a login's category. */
export type PasswordType = PasswordCategory | 'bitlocker' | 'note';
export const passwordType = (p: Pick<PasswordView, 'kind' | 'category'>): PasswordType =>
  p.kind === 'login' ? p.category : p.kind;
export const PASSWORD_TYPE_LABELS: Record<PasswordType, string> = {
  ...PASSWORD_CATEGORY_LABELS,
  bitlocker: 'BitLocker recovery key',
  note: 'Secure note',
};
export const passwordTypeLabel = (p: Pick<PasswordView, 'kind' | 'category'>) => PASSWORD_TYPE_LABELS[passwordType(p)];

/** "fw.harbordental.test" from "https://fw.harbordental.test:8443/login", or the raw text if it isn't a URL. */
export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
