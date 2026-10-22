import { createHash } from 'node:crypto';
import type { Branding } from '@atlas/shared';

// PNG and ICO only: Windows draws those itself. An SVG favicon reaches the app as the PNG the Theme page makes from it.
const RASTER = /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=]+)$/;

/**
 * The icon Atlas for Windows takes for its window, taskbar, and tray: the PNG made from the favicon when the theme
 * was saved, or the favicon itself when it's a PNG or ICO. Null when the theme has no icon Windows can draw. The ETag
 * changes only when the picture does, so the app's regular check costs nothing until then.
 */
export function appIcon(branding: Pick<Branding, 'appIcon' | 'favicon'>) {
  for (const url of [branding.appIcon, branding.favicon]) {
    const match = url ? RASTER.exec(url) : null;
    if (!match) continue;
    const body = Buffer.from(match[2]!, 'base64');
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    return { type: match[1]!, body, etag };
  }
  return null;
}
