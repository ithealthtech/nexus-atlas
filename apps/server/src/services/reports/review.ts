import { REPORT_INFO, REVIEW_PACK_PARTS } from '@atlas/shared';
import type { Collector } from './context.js';
import { executive } from './executive.js';
import { renewals } from './renewals.js';
import { security } from './security.js';
import { service } from './service.js';

const PARTS: Record<(typeof REVIEW_PACK_PARTS)[number], Collector> = { executive, security, service, renewals };

/**
 * A quarterly business review for one client: the reports it's made of, one after another on the same sources, each
 * section marked with the report it came from. The period looks back for the service review and ahead for renewals.
 */
export const review: Collector = async (report) => {
  for (const kind of REVIEW_PACK_PARTS) {
    const from = report.snapshot.sections.length;
    await PARTS[kind](report);
    for (const section of report.snapshot.sections.slice(from)) section.part = REPORT_INFO[kind].name;
  }
};
