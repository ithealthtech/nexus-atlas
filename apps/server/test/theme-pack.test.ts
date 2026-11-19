import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadThemePack, withThemePack } from '../src/services/theme-pack.js';

const BASE = { DATABASE_URL: 'postgres://atlas@127.0.0.1:5432/atlas' };

function pack(css = ':root { --primary: #145e9c; }') {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-pack-'));
  writeFileSync(join(dir, 'theme.css'), css);
  return dir;
}

describe('hosted edition settings', () => {
  it('defaults to the self-hosted edition with no theme pack', () => {
    const config = loadConfig(BASE);
    expect(config.ATLAS_EDITION).toBe('selfhosted');
    expect(config.ATLAS_THEME_PACK).toBeUndefined();
    expect(loadThemePack(config)).toBeNull();
  });

  it('rejects a theme pack on a self-hosted install', () => {
    expect(() => loadConfig({ ...BASE, ATLAS_THEME_PACK: pack() })).toThrow(/only used when ATLAS_EDITION=cloud/);
  });

  it('rejects an unknown edition', () => {
    expect(() => loadConfig({ ...BASE, ATLAS_EDITION: 'enterprise' })).toThrow(/ATLAS_EDITION/);
  });

  it('loads nothing for the cloud edition without a pack', () => {
    expect(loadThemePack(loadConfig({ ...BASE, ATLAS_EDITION: 'cloud' }))).toBeNull();
  });

  it('stops startup when the pack has no theme.css', () => {
    const empty = mkdtempSync(join(tmpdir(), 'atlas-pack-'));
    expect(() => loadThemePack({ ATLAS_EDITION: 'cloud', ATLAS_THEME_PACK: empty })).toThrow(/no theme.css/);
  });
});

describe('theme pack page', () => {
  it('adds the stylesheet after the built styles, versioned by its content', () => {
    const first = loadThemePack({ ATLAS_EDITION: 'cloud', ATLAS_THEME_PACK: pack() })!;
    const page = withThemePack(
      '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>',
      first,
    );
    expect(page).toMatch(/app\.css"><link rel="stylesheet" href="\/theme-pack\/theme\.css\?v=[0-9a-f]{12}"><\/head>/);

    const changed = loadThemePack({ ATLAS_EDITION: 'cloud', ATLAS_THEME_PACK: pack(':root { --primary: #000; }') })!;
    expect(changed.link).not.toBe(first.link);
  });
});
