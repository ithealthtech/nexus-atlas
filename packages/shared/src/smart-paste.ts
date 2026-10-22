// ---------- smart paste: a device's details from what a command printed ----------
/**
 * What a technician can paste into a new asset: the output of `ipconfig /all`, `systeminfo`, or PowerShell's
 * `Get-ComputerInfo` on Windows, `system_profiler SPHardwareDataType` on a Mac, or `hostnamectl` on Linux. Several
 * can be pasted together. Only what's clearly there is read: nothing is guessed except the device type, from the
 * operating system and the hardware's own description.
 */
export interface MachineInfo {
  hostname?: string;
  /** Usable IPv4 addresses, most likely first (the adapter with a default gateway). */
  ipAddresses: string[];
  /** The MAC address of the adapter holding the first IP address, written AA:BB:CC:DD:EE:FF. */
  macAddress?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  operatingSystem?: string;
  /** Server, Laptop, or Workstation, when the paste says enough to tell. */
  type?: 'Server' | 'Laptop' | 'Workstation';
  domain?: string;
}

/** "Name . . . . : value", "Name: value", or "Name : value", as each command lines them up. */
function pairs(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match =
      /^\s*([A-Za-z][A-Za-z0-9 ()/.\-_]*?)[ .]*:\s(.*)$/.exec(raw) ??
      /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw);
    if (match)
      out.push([
        match[1]!
          .replace(/[ .]+$/, '')
          .trim()
          .toLowerCase(),
        match[2]!.trim(),
      ]);
  }
  return out;
}

const IPV4 = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/;
/** Not loopback, not link-local (APIPA), and not unspecified. */
const usable = (ip: string) => !/^(127\.|169\.254\.|0\.)/.test(ip);
const mac = (value: string) => {
  const hex = value.replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? hex.toUpperCase().match(/../g)!.join(':') : undefined;
};
/** Values that only say nothing is there. */
const meaningful = (value: string | undefined) =>
  value &&
  !/^(to be filled by o\.?e\.?m\.?|default string|system serial number|none|n\/a|0+|not specified|unknown)$/i.test(
    value,
  )
    ? value
    : undefined;

export function parseMachineInfo(text: string): MachineInfo {
  const info: MachineInfo = { ipAddresses: [] };
  const all = pairs(text);
  const first = (...names: string[]) => meaningful(all.find(([k]) => names.includes(k))?.[1]);

  info.hostname = first('host name', 'csname', 'computer name', 'static hostname', 'csdnshostname');
  info.manufacturer = first('system manufacturer', 'csmanufacturer', 'hardware vendor', 'manufacturer');
  info.model = first('system model', 'csmodel', 'model name', 'hardware model');
  if (info.manufacturer === undefined && /^(MacBook|iMac|Mac mini|Mac Pro|Mac Studio)/.test(info.model ?? ''))
    info.manufacturer = 'Apple';
  // Microsoft's own Get-ComputerInfo spells it "BiosSeralNumber".
  info.serialNumber = first(
    'biosseralnumber',
    'biosserialnumber',
    'serial number (system)',
    'serial number',
    'serialnumber',
  );
  info.domain = first('domain', 'csdomain');
  if (info.domain && /^workgroup$/i.test(info.domain)) info.domain = undefined;

  // The operating system and its build, as Windows names them; or macOS's and Linux's own lines.
  const osName = first('os name', 'osname', 'windowsproductname', 'operating system', 'system version');
  const build = first('os version', 'osversion')
    ?.replace(/\s*N\/A\s*/i, ' ')
    .replace(/\s+/g, ' ');
  if (osName) info.operatingSystem = build && !osName.includes(build.split(' ')[0]!) ? `${osName} (${build})` : osName;

  // ipconfig: each adapter is a block. The adapter with a default gateway comes first; its MAC goes with it.
  const adapters: { ips: string[]; mac?: string; gateway: boolean }[] = [];
  let current: (typeof adapters)[0] | null = null;
  let inGateway = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*adapter .*:\s*$/i.test(line)) {
      current = { ips: [], gateway: false };
      adapters.push(current);
      inGateway = false;
      continue;
    }
    if (!current) continue;
    const [key, value = ''] = line.split(/ :\s?|:\s/, 2).map((s) => s.trim());
    const name = (key ?? '').replace(/[ .]+$/, '').toLowerCase();
    if (name === 'physical address') current.mac = mac(value);
    else if (name.startsWith('ipv4 address') || name === 'ip address') {
      const ip = IPV4.exec(value)?.[1];
      if (ip && usable(ip)) current.ips.push(ip);
    } else if (name === 'default gateway') {
      inGateway = true;
      if (IPV4.test(value)) current.gateway = true;
    } else if (inGateway && !line.includes(' : ') && IPV4.test(line)) {
      // The gateway's IPv4 address, on its own line under an IPv6 one.
      current.gateway = true;
    } else if (name) inGateway = false;
  }
  const ordered = [...adapters.filter((a) => a.gateway), ...adapters.filter((a) => !a.gateway)].filter(
    (a) => a.ips.length,
  );
  info.ipAddresses = ordered.flatMap((a) => a.ips);
  info.macAddress = ordered[0]?.mac;

  // systeminfo lists addresses under its network cards; Get-ComputerInfo doesn't. Only when ipconfig gave none.
  if (!info.ipAddresses.length) {
    const listed = [...text.matchAll(/\[\d+\]:\s*((?:\d{1,3}\.){3}\d{1,3})\b/g)].map((m) => m[1]!);
    info.ipAddresses = [...new Set(listed.filter(usable))];
  }

  // The device type: a server OS, then the hardware's own word for a portable.
  const os = info.operatingSystem ?? '';
  const productType = first('osproducttype');
  const systemType = first('cspcsystemtype', 'cspcsystemtypeex', 'chassis');
  if (/server/i.test(os) || /server/i.test(productType ?? '') || /^server\b/i.test(systemType ?? ''))
    info.type = 'Server';
  else if (/mobile|laptop|notebook|portable/i.test(systemType ?? '') || /macbook/i.test(info.model ?? ''))
    info.type = 'Laptop';
  else if (os || systemType) info.type = 'Workstation';

  for (const key of Object.keys(info) as (keyof MachineInfo)[]) if (info[key] === undefined) delete info[key];
  return info;
}

/**
 * Which of a layout's fields each found value belongs in, by the field's key or its label: Configurations' own
 * fields, and the same names on any layout an administrator made. A select only takes a value it offers.
 */
export function smartPasteFields(
  info: MachineInfo,
  fields: { key: string; label: string; type: string; options?: string[] | null }[],
): { key: string; label: string; value: string }[] {
  const wanted: [RegExp, string | undefined][] = [
    [/^(hostname|host ?name|computer ?name|device ?name)$/i, info.hostname],
    [/^(ip|ip_address|ip address|ipv4|ipv4 address|primary ip)$/i, info.ipAddresses[0]],
    [/^(mac|mac_address|mac address)$/i, info.macAddress],
    [/^(manufacturer|make|vendor)$/i, info.manufacturer],
    [/^(model)$/i, info.model],
    [/^(serial|serial_number|serial number|service tag)$/i, info.serialNumber],
    [/^(os|operating_system|operating system)$/i, info.operatingSystem],
    [/^(type|device type)$/i, info.type],
    [/^(domain)$/i, info.domain],
  ];
  const out: { key: string; label: string; value: string }[] = [];
  for (const [pattern, value] of wanted) {
    if (!value) continue;
    const field = fields.find((f) => pattern.test(f.key) || pattern.test(f.label));
    if (!field || out.some((o) => o.key === field.key)) continue;
    if (field.type === 'select') {
      const option = field.options?.find((o) => o.toLowerCase() === value.toLowerCase());
      if (option) out.push({ key: field.key, label: field.label, value: option });
    } else if (['text', 'ip', 'textarea'].includes(field.type)) out.push({ key: field.key, label: field.label, value });
  }
  return out;
}
