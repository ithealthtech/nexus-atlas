import type { SoftwareFlag } from '@atlas/shared';

/**
 * Software past its vendor's end of support, with the date support ended. Built in, so no lookup service or key
 * is needed; the dates are the vendors' published lifecycle dates.
 */
const END_OF_LIFE: { match: RegExp; ended: string; label: string }[] = [
  { match: /\bmicrosoft (office|visio|project)\b.*\b(2003|2007)\b/i, ended: '2017-10-10', label: 'Office 2007' },
  { match: /\bmicrosoft (office|visio|project)\b.*\b2010\b/i, ended: '2020-10-13', label: 'Office 2010' },
  { match: /\bmicrosoft (office|visio|project)\b.*\b2013\b/i, ended: '2023-04-11', label: 'Office 2013' },
  {
    match: /\bmicrosoft (office|visio|project)\b.*\b(2016|2019)\b/i,
    ended: '2025-10-14',
    label: 'Office 2016 and 2019',
  },
  { match: /\bmicrosoft exchange server\b.*\b2013\b/i, ended: '2023-04-11', label: 'Exchange 2013' },
  { match: /\bmicrosoft exchange server\b.*\b(2016|2019)\b/i, ended: '2025-10-14', label: 'Exchange 2016 and 2019' },
  { match: /\bmicrosoft sql server\b.*\b(2005|2008)\b/i, ended: '2019-07-09', label: 'SQL Server 2008' },
  { match: /\bmicrosoft sql server\b.*\b2012\b/i, ended: '2022-07-12', label: 'SQL Server 2012' },
  { match: /\bmicrosoft sql server\b.*\b2014\b/i, ended: '2024-07-09', label: 'SQL Server 2014' },
  { match: /\badobe flash player\b/i, ended: '2020-12-31', label: 'Flash Player' },
  { match: /\bmicrosoft silverlight\b/i, ended: '2021-10-12', label: 'Silverlight' },
  { match: /^quicktime\b/i, ended: '2016-01-01', label: 'QuickTime for Windows' },
  { match: /\badobe (acrobat|reader)\b.*\b(xi|x|2015|2017)\b/i, ended: '2022-06-06', label: 'This Acrobat release' },
  { match: /^java(\(tm\))?( se)? ?(6|7)\b/i, ended: '2022-07-31', label: 'Java 7 and older' },
  { match: /^python 2\.\d/i, ended: '2020-01-01', label: 'Python 2' },
];

/**
 * Paid products that should have a license record in the client. `license` finds that record by its product, vendor,
 * or name; anything not listed here (free tools, runtimes, drivers) is never flagged as unlicensed.
 */
const LICENSED: { family: string; match: RegExp; license: RegExp }[] = [
  {
    family: 'Microsoft Office',
    // The suite and its apps, but not the free viewers, runtimes, or language packs.
    match:
      /^microsoft (office|365 apps|visio|project)\b(?!.*\b(viewer|runtime|proofing|language|click-to-run|shared|mui)\b)/i,
    license: /\boffice\b|microsoft 365|\bm365\b|\bo365\b|\bvisio\b|\bproject\b/i,
  },
  {
    family: 'Adobe Acrobat',
    match: /^adobe acrobat\b(?!.*\breader\b)/i,
    license: /acrobat|adobe (creative cloud|document cloud)/i,
  },
  {
    family: 'Adobe Creative Cloud',
    match:
      /^adobe (photoshop|illustrator|indesign|premiere|after effects|lightroom classic|dreamweaver|animate|audition)\b/i,
    license: /creative cloud|photoshop|illustrator|indesign|premiere|after effects|lightroom|adobe/i,
  },
  { family: 'Autodesk', match: /^(autodesk |autocad\b|revit\b)/i, license: /autodesk|autocad|revit/i },
  { family: 'QuickBooks', match: /^quickbooks\b/i, license: /quickbooks|intuit/i },
  { family: 'Bluebeam Revu', match: /^bluebeam revu\b/i, license: /bluebeam/i },
  { family: 'SolidWorks', match: /^solidworks\b/i, license: /solidworks|dassault/i },
  {
    family: 'SQL Server',
    match:
      /^microsoft sql server \d{4}\b(?!.*\b(express|localdb|management|native client|tools|setup|browser|writer|compact)\b)/i,
    license: /sql server/i,
  },
  { family: 'VMware Workstation', match: /^vmware workstation\b/i, license: /vmware/i },
];

/** A license record in the client: the text to match (product, vendor, name) and its seat count, if any. */
export interface LicenseRecord {
  text: string;
  seats: number | null;
}

/** The software family a paid application belongs to, or undefined for anything that needs no license. */
export const licensedFamily = (name: string) => LICENSED.find((l) => l.match.test(name.trim()));

/** Whether an application is past its vendor's end of support (on `today`), and a sentence saying so. */
export function endOfLife(name: string, today = new Date()): string | null {
  const rule = END_OF_LIFE.find((r) => r.match.test(name.trim()));
  if (!rule || new Date(`${rule.ended}T00:00:00Z`) > today) return null;
  return `${rule.label} has been out of support since ${rule.ended}.`;
}

/**
 * Flags for a client's software: `installs` counts the client's devices with each licensed family installed. The
 * end-of-support flag comes first, since it matters whether or not there is a license.
 */
export function softwareFlagger(licenses: LicenseRecord[], installs: Map<string, number>, today = new Date()) {
  return (name: string): { flag: SoftwareFlag | null; flagReason: string } => {
    const eol = endOfLife(name, today);
    if (eol) return { flag: 'end_of_life', flagReason: eol };
    const family = licensedFamily(name);
    if (!family) return { flag: null, flagReason: '' };
    const records = licenses.filter((l) => family.license.test(l.text));
    if (!records.length)
      return { flag: 'unlicensed', flagReason: `No ${family.family} license is recorded for this client.` };
    // Seats count only when every matching record gives one; a record without seats may cover any number.
    const seats = records.every((r) => r.seats !== null) ? records.reduce((n, r) => n + r.seats!, 0) : null;
    const count = installs.get(family.family) ?? 0;
    if (seats !== null && count > seats)
      return {
        flag: 'over_seats',
        flagReason: `${family.family} is on ${count} devices, but its licenses cover ${seats} seat${seats === 1 ? '' : 's'}.`,
      };
    return { flag: null, flagReason: '' };
  };
}
