import nodemailer from 'nodemailer';
import { HttpError } from '../errors.js';
import type { SettingsService, SmtpConfig } from './settings.js';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain paragraphs; each becomes a <p> in the HTML version. */
  paragraphs: string[];
  /** Optional call-to-action button. */
  action?: { label: string; url: string };
  /** Optional list rendered as a table (for digests). */
  rows?: { cells: string[]; url?: string }[];
}
export interface SendArgs {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}
/** Sends one message over a given SMTP configuration. Tests replace this with a capture. */
export type MailTransport = (smtp: SmtpConfig, message: SendArgs) => Promise<void>;

export const smtpTransport: MailTransport = async (smtp, message) => {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  try {
    await transporter.sendMail(message);
  } finally {
    transporter.close();
  }
};

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function render(message: MailMessage, orgName: string): { text: string; html: string } {
  const text = [
    ...message.paragraphs,
    ...(message.rows ?? []).map((r) => `- ${r.cells.join(' · ')}${r.url ? ` (${r.url})` : ''}`),
    ...(message.action ? [`${message.action.label}: ${message.action.url}`] : []),
    `— ${orgName} · MSP Atlas`,
  ].join('\n\n');
  const rows = message.rows?.length
    ? `<table role="presentation" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:14px">${message.rows
        .map(
          (r) =>
            `<tr style="border-top:1px solid #e3e8e5">${r.cells
              .map(
                (c, i) =>
                  `<td>${i === 0 && r.url ? `<a href="${escape(r.url)}" style="color:#1f6f4a">${escape(c)}</a>` : escape(c)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')}</table>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:Segoe UI,Arial,sans-serif;color:#17211c">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e8e5">
<p style="margin:0 0 18px;font-weight:700;color:#1f6f4a">${escape(orgName)} · MSP Atlas</p>
${message.paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5">${escape(p)}</p>`).join('\n')}
${rows}
${message.action ? `<p style="margin:24px 0"><a href="${escape(message.action.url)}" style="background:#1f6f4a;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escape(message.action.label)}</a></p>` : ''}
</div></body></html>`;
  return { text, html };
}

export class MailService {
  constructor(
    private readonly settings: SettingsService,
    private readonly transport: MailTransport,
  ) {}

  async enabled(orgId: string) {
    return !!(await this.settings.smtpConfig(orgId));
  }

  /** Sends a message; throws when email is not configured or the server rejects it. */
  async send(orgId: string, orgName: string, message: MailMessage) {
    const smtp = await this.settings.smtpConfig(orgId);
    if (!smtp) throw new HttpError(409, 'Email is not set up. An administrator can turn it on in Settings.');
    const { text, html } = render(message, orgName);
    const name = smtp.fromName.replace(/["\r\n]/g, '');
    try {
      await this.transport(smtp, {
        from: name ? `"${name}" <${smtp.fromAddress}>` : smtp.fromAddress,
        to: message.to,
        subject: message.subject.replace(/[\r\n]/g, ' '),
        text,
        html,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
      throw new HttpError(502, `The mail server did not accept the message: ${detail}`);
    }
  }
}
