/**
 * Works out a device's manufacturer from what is usually already known about it: the model ("OptiPlex 7090"),
 * the operating system (virtual machines), its name or hostname, and, as a last resort, the MAC address.
 * Only whole-device makers are recognized; network-card makers like Intel or Realtek say nothing about the box.
 */

/**
 * Model and product-line names, checked in order; the first match wins. Lines marked model-only are words that
 * are also common names for servers and PCs ("NEXUS", "APOLLO"), so they count only in the model or OS.
 */
const PRODUCT_LINES: [RegExp, string, modelOnly?: boolean][] = [
  // Virtual machines, before any hardware name they might mention.
  [/\bvmware\b/i, 'VMware'],
  [/\bhyper-?v\b|\bvirtual machine\b/i, 'Microsoft'],
  [/\bvirtualbox\b/i, 'Oracle'],
  [/\bkvm\b|\bqemu\b|\bproxmox\b/i, 'QEMU'],
  [/\bamazon ec2\b/i, 'Amazon'],
  [/\bgoogle compute engine\b/i, 'Google'],
  // Dell
  [/\b(optiplex|latitude|inspiron|vostro|poweredge|powervault|powerconnect|alienware|wyse)\b/i, 'Dell'],
  [/\b(precision|xps)\b/i, 'Dell', true],
  // Lenovo
  [/\b(thinkpad|thinkcentre|thinkstation|thinksystem|thinkedge|thinkbook|ideapad|ideacentre)\b/i, 'Lenovo'],
  [/\b(legion|yoga)\b/i, 'Lenovo', true],
  // HPE servers and Aruba networking, then HP PCs and printers
  [/\bproliant\b/i, 'HPE'],
  [/\b(synergy|apollo)\b/i, 'HPE', true],
  [/\baruba\b|\binstant on\b/i, 'HPE Aruba'],
  [/\b(elitebook|probook|elitedesk|prodesk|elite ?one|zbook|laserjet|officejet|deskjet|designjet|pagewide)\b/i, 'HP'],
  [/\b(pro ?one|omen|pavilion|envy|spectre|z[2468] g\d)\b/i, 'HP', true],
  [/\bhewlett[- ]?packard\b/i, 'HP'],
  // Microsoft and Apple
  [/\bsurface (pro|laptop|book|go|studio|hub)\b/i, 'Microsoft'],
  [/\bsurface\b/i, 'Microsoft', true],
  [/\b(macbook|imac|mac ?mini|mac ?pro|mac ?studio|iphone|ipad)\b/i, 'Apple'],
  // Other PCs and servers
  [/\b(zenbook|vivobook|expertbook|expertcenter)\b/i, 'ASUS'],
  [/\b(rog|tuf gaming)\b/i, 'ASUS', true],
  [/\b(travelmate|veriton)\b/i, 'Acer'],
  [/\b(aspire|predator|swift)\b/i, 'Acer', true],
  [/\b(galaxy book|galaxy tab)\b/i, 'Samsung', true],
  [/\bsupermicro\b|\bsuperserver\b/i, 'Supermicro'],
  [/\bnuc\d*\b/i, 'Intel', true],
  [/\b(toughbook|toughpad)\b/i, 'Panasonic'],
  [/\b(lifebook|esprimo|celsius|primergy|scansnap)\b/i, 'Fujitsu'],
  // Networking and security
  [/\bmeraki\b/i, 'Cisco Meraki'],
  [/\b(firepower|cisco)\b/i, 'Cisco'],
  [/\b(catalyst|nexus|isr ?\d{4}|asa ?\d{4})\b/i, 'Cisco', true],
  [/\b(unifi|edgerouter|edgeswitch|ubiquiti|dream machine)\b/i, 'Ubiquiti'],
  [/\b(udm|udr|usg|usw|uap)\b/i, 'Ubiquiti', true],
  [/\bforti(gate|switch|ap|wifi|analyzer|manager|mail|web)\b/i, 'Fortinet'],
  [/\b(sonicwall|sonicwave)\b/i, 'SonicWall'],
  [/\b(tz\d{2,3}|nsa ?\d{4})\b/i, 'SonicWall', true],
  [/\b(firebox|watchguard)\b/i, 'WatchGuard'],
  [/\bpalo alto\b/i, 'Palo Alto Networks'],
  [/\bpa-\d{3,4}\b/i, 'Palo Alto Networks', true],
  [/\bjuniper\b/i, 'Juniper'],
  [/\b(srx|qfx)\d{3,4}\b|\bex\d{4}\b/i, 'Juniper', true],
  [/\bnetgear\b/i, 'Netgear'],
  [/\b(gs|fs|xs)\d{3}[a-z]*\b|\borbi\b/i, 'Netgear', true],
  [/\b(tp-link|omada)\b/i, 'TP-Link'],
  [/\b(mikrotik|routerboard)\b/i, 'MikroTik'],
  [/\bdraytek\b/i, 'DrayTek'],
  [/\bruckus\b/i, 'Ruckus'],
  [/\bcradlepoint\b/i, 'Cradlepoint'],
  [/\b(peplink|pepwave)\b/i, 'Peplink'],
  // Storage, power, and phones
  [/\bsynology\b/i, 'Synology'],
  [/\b(ds|rs)\d{3,4}(\+|xs\+?|j)?\b/i, 'Synology', true],
  [/\bqnap\b/i, 'QNAP'],
  [/\bts-\d{3,4}/i, 'QNAP', true],
  [/\b(equallogic|compellent)\b/i, 'Dell'],
  [/\bnetapp\b/i, 'NetApp'],
  [/\b(smart-ups|back-ups|symmetra)\b/i, 'APC'],
  [/\beaton\b/i, 'Eaton'],
  [/\bcyberpower\b/i, 'CyberPower'],
  [/\bpolycom\b/i, 'Poly'],
  [/\bvvx ?\d{3}|\bpoly (ccx|edge|trio|studio)\b/i, 'Poly', true],
  [/\byealink\b/i, 'Yealink'],
  [/\bsip-t\d{2}/i, 'Yealink', true],
  [/\bgrandstream\b/i, 'Grandstream'],
  // Printers and scanners
  [/\b(ecosys|taskalfa|kyocera)\b/i, 'Kyocera'],
  [/\b(imagerunner|imageclass|pixma|maxify|imageprograf)\b/i, 'Canon'],
  [/\b(versalink|altalink|workcentre|xerox)\b/i, 'Xerox'],
  [/\bricoh\b/i, 'Ricoh'],
  [/\bbrother\b/i, 'Brother'],
  [/\b(hl|mfc|dcp)-[a-z]{0,3}\d{3,4}/i, 'Brother', true],
  [/\b(epson|ecotank)\b/i, 'Epson'],
  [/\blexmark\b/i, 'Lexmark'],
  [/\b(konica|bizhub)\b/i, 'Konica Minolta'],
  [/\bzebra\b/i, 'Zebra'],
  [/\b(zt|zd)\d{3}\b/i, 'Zebra', true],
];

// Raw manufacturer strings from firmware and RMM agents, and the name Atlas shows for each.
const ALIASES: [RegExp, string][] = [
  [/^dell( inc\.?| computer corporation)?$/i, 'Dell'],
  [/^lenovo$/i, 'Lenovo'],
  [/^(hp|hewlett[- ]?packard)( inc\.?| development company.*)?$/i, 'HP'],
  [/^(hewlett packard enterprise|hpe)$/i, 'HPE'],
  [/^microsoft( corporation)?$/i, 'Microsoft'],
  [/^apple( inc\.?)?$/i, 'Apple'],
  [/^vmware(, inc\.?)?$/i, 'VMware'],
  [/^(asustek computer inc\.?|asus)$/i, 'ASUS'],
  [/^acer$/i, 'Acer'],
  [/^samsung electronics( co\.?,? ltd\.?)?$/i, 'Samsung'],
  [/^(supermicro|super micro computer.*)$/i, 'Supermicro'],
  [/^intel( corporation)?$/i, 'Intel'],
  [/^fujitsu( limited| client computing.*)?$/i, 'Fujitsu'],
  [/^panasonic( corporation)?$/i, 'Panasonic'],
  [/^qemu$/i, 'QEMU'],
  [/^innotek gmbh$/i, 'Oracle'],
];

// MAC address prefixes (OUIs) of makers that build whole devices. Deliberately short: a missing prefix just
// means nothing is detected, while a wrong one would put a false name on the asset.
const OUIS: Record<string, string> = {
  '000C29': 'VMware',
  '005056': 'VMware',
  '000569': 'VMware',
  '00155D': 'Microsoft',
  '080027': 'Oracle',
  '001132': 'Synology',
  '90095D': 'Synology',
  '245EBE': 'QNAP',
  '00089B': 'QNAP',
  FCECDA: 'Ubiquiti',
  '245A4C': 'Ubiquiti',
  '788A20': 'Ubiquiti',
  '7483C2': 'Ubiquiti',
  E063DA: 'Ubiquiti',
  '68D79A': 'Ubiquiti',
  '18E829': 'Ubiquiti',
  F09FC2: 'Ubiquiti',
  '00180A': 'Cisco Meraki',
  E0553D: 'Cisco Meraki',
  '0C8DDB': 'Cisco Meraki',
  AC17C8: 'Cisco Meraki',
  '88155F': 'Cisco Meraki',
  '00090F': 'Fortinet',
  '906CAC': 'Fortinet',
  '704CA5': 'Fortinet',
  E81CBA: 'Fortinet',
  '0017C5': 'SonicWall',
  C0EAE4: 'SonicWall',
  '18B169': 'SonicWall',
  '00907F': 'WatchGuard',
  '008077': 'Brother',
  '30055C': 'Brother',
  '3C2AF4': 'Brother',
  '0000AA': 'Xerox',
  '9C934E': 'Xerox',
  '002673': 'Ricoh',
  '0026AB': 'Epson',
  '64EB8C': 'Epson',
  '0004F2': 'Poly',
  '64167F': 'Poly',
  '805EC0': 'Yealink',
  '001565': 'Yealink',
  '000B82': 'Grandstream',
  C074AD: 'Grandstream',
  '00C0B7': 'APC',
  '4C5E0C': 'MikroTik',
  E48D8C: 'MikroTik',
};

/** A manufacturer name as Atlas shows it ("Dell Inc." → "Dell"); unknown names come back trimmed. */
export function normalizeManufacturer(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ');
  // Placeholders firmware leaves when nobody filled it in.
  if (/^(to be filled by o\.?e\.?m\.?|system manufacturer|default string|oem|n\/?a|unknown|none)$/i.test(v)) return '';
  return ALIASES.find(([pattern]) => pattern.test(v))?.[1] ?? v;
}

/** The manufacturer suggested by a device's model, OS, name, or MAC address, or '' when there's no clear sign. */
export function detectManufacturer(d: {
  model?: string;
  name?: string;
  hostname?: string;
  os?: string;
  mac?: string;
}): string {
  const sources: [string | undefined, boolean][] = [
    [d.model, true],
    [d.os, true],
    [d.name, false],
    [d.hostname, false],
  ];
  for (const [text, trusted] of sources) {
    if (!text) continue;
    const found = PRODUCT_LINES.find(([pattern, , modelOnly]) => (trusted || !modelOnly) && pattern.test(text));
    if (found) return found[1];
  }
  // Each MAC in a list (agents report several), skipping locally administered and randomized ones.
  for (const mac of (d.mac ?? '').split(/[,;\s]+/)) {
    const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hex.length !== 12 || parseInt(hex.slice(0, 2), 16) & 0x02) continue;
    const maker = OUIS[hex.slice(0, 6)];
    if (maker) return maker;
  }
  return '';
}
