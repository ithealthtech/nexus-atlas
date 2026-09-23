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
export const onUnauthenticated = (handler: () => void) => {
  onSessionLost = handler;
};

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
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
