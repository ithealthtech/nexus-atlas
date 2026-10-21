import type { Collector } from './context.js';

/** One row per client: how much is documented, and how its devices are doing. */
export const executive: Collector = async (report) => {
  const assets = await report.assets();
  const documents = await report.documents();
  const licenses = await report.licenses();
  const endpoints = await report.endpoints();
  report.section(
    'Client overview',
    [
      'Client',
      'Assets',
      'Documents',
      'Reviews overdue',
      'Tracked subscriptions',
      'Endpoints',
      'Offline',
      'Protection missing / stopped',
      'Unknown protection',
    ],
    report.clients.map((c) => {
      const devices = endpoints.filter((e) => e.clientId === c.id);
      const count = (n: number) => (devices.length ? String(n) : 'Not available');
      return [
        c.name,
        String(assets.filter((a) => a.clientId === c.id).length),
        String(documents.filter((d) => d.clientId === c.id).length),
        String(documents.filter((d) => d.clientId === c.id && d.reviewDate && d.reviewDate < report.today).length),
        String(licenses.filter((l) => l.clientId === c.id && l.status === 'active').length),
        count(devices.length),
        count(devices.filter((e) => e.online === false).length),
        count(devices.filter((e) => e.protection === 'missing' || e.protection === 'not_running').length),
        count(devices.filter((e) => e.protection === null).length),
      ];
    }),
  );
};
