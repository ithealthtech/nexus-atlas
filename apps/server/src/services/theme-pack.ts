import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.js';

/** Where the pack's files are served. Not under /assets/, which belongs to the built web app. */
export const THEME_PACK_PREFIX = '/theme-pack/';

export interface ThemePack {
  /** Absolute folder the pack's files are served from. */
  root: string;
  /** The <link> added to the web app's page, versioned so a changed pack is picked up without waiting for caches. */
  link: string;
}

/**
 * The hosted edition's theme pack, or null. Self-hosted installs always get null, so their page is served as built.
 * A configured pack that is missing theme.css stops startup: a hosted instance silently showing the wrong look is
 * worse than one that doesn't start.
 */
export function loadThemePack(config: Pick<Config, 'ATLAS_EDITION' | 'ATLAS_THEME_PACK'>): ThemePack | null {
  if (config.ATLAS_EDITION !== 'cloud' || !config.ATLAS_THEME_PACK) return null;
  const root = resolve(config.ATLAS_THEME_PACK);
  const css = join(root, 'theme.css');
  if (!existsSync(css) || !statSync(css).isFile())
    throw new Error(`ATLAS_THEME_PACK is set to ${root}, but there is no theme.css in that folder.`);
  const version = createHash('sha256').update(readFileSync(css)).digest('hex').slice(0, 12);
  return { root, link: `<link rel="stylesheet" href="${THEME_PACK_PREFIX}theme.css?v=${version}">` };
}

/** Adds the pack's stylesheet after the built styles, so its values win. */
export function withThemePack(html: string, pack: ThemePack): string {
  const at = html.toLowerCase().lastIndexOf('</head>');
  return at === -1 ? pack.link + html : html.slice(0, at) + pack.link + html.slice(at);
}
