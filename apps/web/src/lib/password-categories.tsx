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
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { PasswordCategory, PasswordView } from '@atlas/shared';

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
  const Icon = item.kind === 'bitlocker' ? HardDrive : CATEGORY_ICONS[item.category];
  return <Icon className={className} aria-hidden />;
}

/** "fw.harbordental.test" from "https://fw.harbordental.test:8443/login", or the raw text if it isn't a URL. */
export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
