import { zipSync } from 'fflate';
import type { TeamsSettings } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { teamsIcons } from './icons.js';

/** A tenant-specific package, with no secrets, to upload as a custom app in Teams. */
export function teamsAppPackage(settings: TeamsSettings, publicOrigin: string): Buffer {
  if (!settings.appId || !settings.websiteUrl || !settings.privacyUrl || !settings.termsUrl)
    throw new HttpError(
      409,
      'Save the application ID and your website, privacy, and terms URLs to download the Teams app.',
    );
  const manifest = {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
    manifestVersion: '1.19',
    version: '1.0.0',
    id: settings.appId,
    packageName: 'com.mspatlas.teams',
    name: { short: 'Atlas', full: 'Atlas client notifications' },
    developer: {
      name: 'MSP Atlas',
      websiteUrl: settings.websiteUrl,
      privacyUrl: settings.privacyUrl,
      termsOfUseUrl: settings.termsUrl,
    },
    description: {
      short: 'Client notifications from Atlas.',
      full: 'Receive client expiry, review, breach and infection notifications from your Atlas installation.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#315FBC',
    bots: [{ botId: settings.appId, scopes: ['team'], isNotificationOnly: true, supportsFiles: false }],
    validDomains: [new URL(publicOrigin).hostname],
  };
  return Buffer.from(
    zipSync({
      'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)),
      'color.png': Buffer.from(teamsIcons.color, 'base64'),
      'outline.png': Buffer.from(teamsIcons.outline, 'base64'),
    }),
  );
}
