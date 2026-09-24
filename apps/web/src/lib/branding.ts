import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Branding } from '@atlas/shared';
import { api } from './api';

export type BrandingView = Branding & { name: string };

export const useBranding = () =>
  useQuery({ queryKey: ['branding'], queryFn: () => api<BrandingView>('/branding'), staleTime: 5 * 60_000 });

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/**
 * Applies the organization's accent colour to the theme tokens. Set through the CSSOM (allowed by the strict CSP).
 * In dark mode the colour is lightened so it stays readable; text on it is black or white, whichever contrasts more.
 */
export function applyBranding(accent: string | null) {
  const root = document.documentElement.style;
  const props = ['--primary', '--primary-hover', '--primary-fg', '--primary-soft'];
  if (!accent) {
    props.forEach((p) => root.removeProperty(p));
    return;
  }
  const dark = document.documentElement.classList.contains('dark');
  const base = dark ? `color-mix(in oklab, ${accent} 65%, white)` : accent;
  root.setProperty('--primary', base);
  root.setProperty('--primary-hover', `color-mix(in oklab, ${base} 85%, ${dark ? 'white' : 'black'})`);
  root.setProperty(
    '--primary-soft',
    `color-mix(in oklab, ${accent} ${dark ? '22%' : '12%'}, ${dark ? '#0f1512' : 'white'})`,
  );
  // White text needs a dark enough colour for 4.5:1 contrast (relative luminance below about 0.18).
  const light = dark ? true : luminance(accent) > 0.18;
  root.setProperty('--primary-fg', light ? '#0c1a14' : '#ffffff');
}

/** Keeps the accent applied, including after the theme changes. */
export function useApplyBranding() {
  const { data } = useBranding();
  const accent = data?.accent ?? null;
  useEffect(() => {
    applyBranding(accent);
    const observer = new MutationObserver(() => applyBranding(accent));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [accent]);
  return data;
}
