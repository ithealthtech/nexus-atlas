import { useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_BRANDING, type Branding } from '@atlas/shared';
import { api } from './api';

export type BrandingView = Branding & { name: string };

export const useBranding = () =>
  useQuery({ queryKey: ['branding'], queryFn: () => api<BrandingView>('/branding'), staleTime: 5 * 60_000 });

const DEFAULT_TITLE = 'MSP Atlas';
const DEFAULT_FAVICON = '/favicon.svg';
const ATLAS_BLUE = '#315fbc';
// Atlas's own sidebar colours (styles.css), for checking a custom accent against them.
const DEFAULT_SIDEBAR = '#ffffff';
const DEFAULT_SIDEBAR_DARK = '#13181f';

/** WCAG relative luminance of a #rrggbb colour. */
export const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Near-black or white, whichever reads better on `hex`. */
export const readableOn = (hex: string) =>
  contrast(hex, '#0c1a14') >= contrast(hex, '#ffffff') ? '#0c1a14' : '#ffffff';

const isDark = () => document.documentElement.classList.contains('dark');

function setVars(vars: Record<string, string | null>) {
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(vars))
    if (value === null) root.removeProperty(name);
    else root.setProperty(name, value);
}

function applyAccent(theme: Branding, dark: boolean) {
  const accent = dark ? (theme.accentDark ?? theme.accent) : theme.accent;
  if (!accent) {
    setVars({ '--primary': null, '--primary-hover': null, '--primary-fg': null, '--primary-soft': null });
    return;
  }
  // Without a dark-mode colour, the light one is lightened so it stays readable on dark surfaces.
  const lightened = dark && !theme.accentDark;
  const base = lightened ? `color-mix(in oklab, ${accent} 65%, white)` : accent;
  setVars({
    '--primary': base,
    '--primary-hover': `color-mix(in oklab, ${base} 85%, ${dark ? 'white' : 'black'})`,
    '--primary-soft': `color-mix(in oklab, ${accent} ${dark ? '22%' : '12%'}, ${dark ? '#0f1512' : 'white'})`,
    '--primary-fg': lightened ? '#0c1a14' : readableOn(accent),
  });
}

function applySidebar(theme: Branding, dark: boolean) {
  const color = dark ? (theme.sidebarDark ?? theme.sidebar) : theme.sidebar;
  const accent = dark ? (theme.accentDark ?? theme.accent) : theme.accent;
  if (!color) {
    // Default sidebar: its colours stay, but a custom accent still shows on it when it's visible enough.
    const sidebar = dark ? DEFAULT_SIDEBAR_DARK : DEFAULT_SIDEBAR;
    setVars({
      '--sidebar': null,
      '--sidebar-2': null,
      '--sidebar-text': null,
      '--sidebar-muted': null,
      '--sidebar-active': null,
      '--sidebar-accent': accent && contrast(accent, sidebar) >= 3 ? accent : null,
    });
    return;
  }
  // Text follows the sidebar's lightness, so a light sidebar gets dark text.
  const ink = readableOn(color);
  // The active icon and bar need 3:1 against the sidebar (WCAG non-text contrast): the org's accent if it
  // manages that, else Atlas's blue, else plain text colour.
  const sidebarAccent = [accent, ATLAS_BLUE].find((c) => c && contrast(c, color) >= 3) ?? ink;
  setVars({
    '--sidebar': color,
    '--sidebar-2': `color-mix(in oklab, ${color} 86%, ${ink})`,
    '--sidebar-text': `color-mix(in oklab, ${ink} 84%, ${color})`,
    '--sidebar-muted': `color-mix(in oklab, ${ink} 68%, ${color})`,
    '--sidebar-active': ink,
    '--sidebar-accent': sidebarAccent,
  });
}

/**
 * The favicon as a square PNG, for Atlas for Windows: Windows can't draw an SVG favicon, and a 16-pixel ICO makes a
 * blurry taskbar icon. Drawn by the browser (which reads PNG, SVG, and ICO), centred and scaled to fit; a smaller
 * size is tried if the PNG would be too big to save. Null if the browser can't draw it.
 */
export async function appIconFrom(favicon: string): Promise<string | null> {
  const image = new Image();
  image.src = favicon;
  try {
    await image.decode();
  } catch {
    return null;
  }
  for (const size of [256, 128]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const width = image.naturalWidth || size;
    const height = image.naturalHeight || size;
    const scale = Math.min(size / width, size / height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (size - width * scale) / 2, (size - height * scale) / 2, width * scale, height * scale);
    const png = canvas.toDataURL('image/png');
    // The theme accepts up to 200 KB (as base64, about 273,000 characters).
    if (png.length < 270_000) return png;
  }
  return null;
}

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  if (link.getAttribute('href') !== href) {
    link.href = href;
    link.removeAttribute('type');
  }
}

/**
 * Applies a theme (Administration → Theme) to the page: colour tokens, layout options (data attributes that
 * styles.css reads), favicon, and title. Set through the CSSOM and DOM, which the strict CSP allows.
 */
export function applyTheme(theme: Branding | null, orgName = '') {
  const t = theme ?? DEFAULT_BRANDING;
  applied = t;
  const dark = isDark();
  applyAccent(t, dark);
  applySidebar(t, dark);
  const html = document.documentElement;
  html.dataset.font = t.fontScale;
  html.dataset.radius = t.radius;
  html.dataset.sidebar = t.sidebarWidth;
  html.dataset.density = t.density;
  html.dataset.nav = t.navStyle;
  html.dataset.motion = t.motion ? 'on' : 'off';
  setFavicon(t.favicon ?? DEFAULT_FAVICON);
  // Blank fields fall back to the organization's name, then to the product name.
  document.title = t.browserTitle || t.brandName || orgName || DEFAULT_TITLE;
}

// Paper always gets the light theme (styles.css keeps dark mode to screens), so the brand colours switch to their
// light versions for printing and back afterwards.
let applied: Branding = DEFAULT_BRANDING;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', () => {
    applyAccent(applied, false);
    applySidebar(applied, false);
  });
  window.addEventListener('afterprint', () => {
    applyAccent(applied, isDark());
    applySidebar(applied, isDark());
  });
}

/** Tracks light/dark mode, so components can pick the right logo. */
export function useDarkMode() {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    isDark,
    () => false,
  );
}

// While an administrator edits the theme, the unsaved draft replaces the saved theme on every screen.
let preview: Branding | null = null;
const previewListeners = new Set<() => void>();
export function setThemePreview(theme: Branding | null) {
  preview = theme;
  previewListeners.forEach((l) => l());
}
const usePreview = () =>
  useSyncExternalStore(
    (l) => {
      previewListeners.add(l);
      return () => {
        previewListeners.delete(l);
      };
    },
    () => preview,
    () => null,
  );

/** The theme in effect: the unsaved preview while editing, otherwise the saved one. */
export function useTheme(): BrandingView | undefined {
  const { data } = useBranding();
  const draft = usePreview();
  return data && draft ? { ...data, ...draft } : data;
}

/** Keeps the theme in effect applied, including after switching between light and dark. */
export function useApplyBranding() {
  const theme = useTheme();
  const dark = useDarkMode();
  useEffect(() => {
    if (theme) applyTheme(theme, theme.name);
  }, [theme, dark]);
  return theme;
}
