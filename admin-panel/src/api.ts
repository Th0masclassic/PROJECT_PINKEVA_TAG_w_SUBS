import type { SupabaseClient } from '@supabase/supabase-js';

export class AdminApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'AdminApiError';
  }
}

export async function adminRequest<T>(
  client: SupabaseClient,
  apiUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { data } = await client.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new AdminApiError('AUTHENTICATION_REQUIRED', 401);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Do not expose upstream response text or stack traces in this console.
    }
    if (!response.ok) {
      const code =
        payload && typeof payload === 'object' && 'error' in payload &&
        payload.error && typeof payload.error === 'object' && 'code' in payload.error &&
        typeof payload.error.code === 'string'
          ? payload.error.code
          : 'REQUEST_FAILED';
      throw new AdminApiError(code, response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AdminApiError('REQUEST_TIMEOUT', 408);
    }
    throw new AdminApiError('NETWORK_UNAVAILABLE', 503);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function safeAdminMessage(error: unknown): string {
  if (!(error instanceof AdminApiError)) return 'The request could not be completed.';
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: 'Please sign in again.',
    ADMIN_ACCESS_DENIED: 'This account is not an administrator.',
    ADMIN_OWNER_REQUIRED: 'Only an environment owner can do this.',
    ADMIN_MFA_REQUIRED: 'Complete multi-factor authentication first.',
    ADMIN_RESOURCE_NOT_FOUND: 'The requested record no longer exists.',
    ADMIN_CONFLICT: 'The record changed or already exists. Refresh and try again.',
    ADMIN_PROVIDER_UNAVAILABLE: 'Stripe is temporarily unavailable.',
    REQUEST_TIMEOUT: 'The server took too long to respond.',
    NETWORK_UNAVAILABLE: 'Check the secure API connection and try again.',
  };
  return messages[error.code] ?? 'The request could not be completed.';
}
