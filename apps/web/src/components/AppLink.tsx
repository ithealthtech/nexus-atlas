import { Link, useNavigate } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string;
  search?: Record<string, unknown>;
  activeOptions?: { exact?: boolean };
  children: ReactNode;
};

/**
 * Link to a path built at runtime (for example an item's client). TanStack Router checks literal
 * route paths at compile time; resolved paths like /clients/<id>/assets are matched the same way at runtime.
 */
export function AppLink(props: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Link {...(props as any)} />;
}

export function useGo() {
  const navigate = useNavigate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (to: string, search?: Record<string, unknown>) => navigate({ to, search } as any);
}
