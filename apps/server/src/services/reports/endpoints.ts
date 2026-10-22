import { iso, onlineText, type Collector } from './context.js';

/** Every RMM device: online, last check-in, and endpoint protection. */
export const endpoints: Collector = async (report) => {
  const devices = await report.endpoints();
  report.section(
    'Endpoint health',
    ['Client', 'Device', 'Type', 'Online', 'Last check-in', 'Protection', 'Last sync'],
    devices.map((e) => [
      report.client(e.clientId),
      e.name,
      e.kind,
      onlineText(e.online),
      iso(e.lastSeenAt) || 'Unknown',
      e.protection ?? 'Unknown',
      iso(e.updatedAt),
    ]),
  );
};
