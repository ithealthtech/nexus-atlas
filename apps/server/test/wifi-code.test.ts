import { describe, expect, it } from 'vitest';
import { wifiJoinCode } from '@atlas/shared';

describe('Wi-Fi join codes', () => {
  it('writes the code phones read to join', () => {
    expect(wifiJoinCode({ ssid: 'HDG-Guest', password: 'smile-2026' })).toBe('WIFI:T:WPA;S:HDG-Guest;P:smile-2026;;');
  });

  it('escapes the characters the format reserves', () => {
    expect(wifiJoinCode({ ssid: 'Dr. "Okafor\'s" Office;5G', password: 'a\\b:c,d;e' })).toBe(
      'WIFI:T:WPA;S:Dr. \\"Okafor\'s\\" Office\\;5G;P:a\\\\b\\:c\\,d\\;e;;',
    );
  });

  it('leaves the password out of an open network and marks a hidden one', () => {
    expect(wifiJoinCode({ ssid: 'Lobby', password: 'ignored', security: 'nopass' })).toBe('WIFI:T:nopass;S:Lobby;;');
    expect(wifiJoinCode({ ssid: 'Back office', password: 'x', hidden: true })).toBe(
      'WIFI:T:WPA;S:Back office;P:x;H:true;;',
    );
  });
});
