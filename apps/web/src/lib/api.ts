import type { ApiError as ApiErrorBody } from '@atlas/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

let csrf = '';
let onSessionLost: () => void = () => undefined;
export const setCsrf = (token: string) => {
  csrf = token;
};
export const getCsrf = () => csrf;
export const onUnauthenticated = (handler: () => void) => {
  onSessionLost = handler;
};

// Sensitive actions answer 403 "reauth" when the password wasn't confirmed recently. The app registers a
// handler that asks for it; the request is then retried once.
let confirmPassword: (() => Promise<boolean>) | null = null;
export const onReauthRequired = (handler: (() => Promise<boolean>) | null) => {
  confirmPassword = handler;
};

async function withReauth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'reauth' && confirmPassword && (await confirmPassword()))
      return run();
    throw error;
  }
}

export function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  return withReauth(() => request<T>(path, options));
}

/** Downloads a file response (CSV exports) through the same session and reauth handling. */
export function download(path: string, filename: string): Promise<void> {
  return withReauth(async () => {
    const response = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(response.status, data?.error ?? 'The download failed.', data?.code);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

async function request<T>(path: string, options: { method?: string; body?: unknown }): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Atlas could not be reached. Check your connection and try again.');
  }
  const data = (await response.json().catch(() => null)) as (ApiErrorBody & T) | null;
  if (!response.ok) {
    if (response.status === 401 && data?.code === 'session') onSessionLost();
    throw new ApiError(
      response.status,
      data?.error ?? 'Something went wrong. Please try again.',
      data?.code,
      data?.fields,
    );
  }
  return data as T;
}
