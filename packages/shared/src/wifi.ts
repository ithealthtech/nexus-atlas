// ---------- Wi-Fi join codes ----------
/** How a network is secured, as a join code names it. WPA covers WPA, WPA2 and WPA3 personal networks. */
export const WIFI_SECURITY = ['WPA', 'WEP', 'nopass'] as const;
export type WifiSecurity = (typeof WIFI_SECURITY)[number];
export const WIFI_SECURITY_LABELS: Record<WifiSecurity, string> = {
  WPA: 'WPA, WPA2 or WPA3',
  WEP: 'WEP',
  nopass: 'Open (no password)',
};

// Inside a value, these have to be escaped with a backslash: \ ; , : and ".
const escape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');

/**
 * The text a phone's camera reads to join a network: WIFI:T:WPA;S:<name>;P:<password>;;, the format iOS and Android
 * both understand. A hidden network says so, or phones won't look for it.
 */
export function wifiJoinCode({
  ssid,
  password,
  security = 'WPA',
  hidden = false,
}: {
  ssid: string;
  password: string;
  security?: WifiSecurity;
  hidden?: boolean;
}): string {
  const parts = [`T:${security}`, `S:${escape(ssid)}`];
  if (security !== 'nopass') parts.push(`P:${escape(password)}`);
  if (hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}
