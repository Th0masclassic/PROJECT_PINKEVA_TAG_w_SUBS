import type { AuthFeedback } from './types';

export type AuthErrorContext =
  | 'configuration'
  | 'login'
  | 'register'
  | 'oauth'
  | 'reset'
  | 'update-password'
  | 'sign-out';

function property(error: unknown, name: string): string | null {
  if (!error || typeof error !== 'object' || !(name in error)) return null;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

export function authErrorCode(error: unknown): string {
  return property(error, 'code') ?? property(error, 'name') ?? 'unknown_auth_error';
}

function isNetworkError(error: unknown): boolean {
  const name = property(error, 'name');
  const message = property(error, 'message')?.toLowerCase() ?? '';
  return (
    name === 'TypeError' ||
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror')
  );
}

const canceledCodes = new Set([
  'ERR_REQUEST_CANCELED',
  'auth_flow_cancelled',
  'dismiss',
  'cancel',
]);

const rateLimitCodes = new Set([
  'over_request_rate_limit',
  'over_email_send_rate_limit',
  '429',
]);

const unavailableCodes = new Set([
  'auth_not_configured',
  'email_provider_disabled',
  'oauth_provider_not_supported',
  'provider_not_available',
  'signup_disabled',
]);

const expiredFlowCodes = new Set([
  'bad_code_verifier',
  'bad_oauth_callback',
  'flow_state_expired',
  'flow_state_not_found',
  'oauth_callback_failed',
  'oauth_callback_missing_code',
  'otp_expired',
]);

const existingIdentityCodes = new Set([
  'email_exists',
  'identity_already_exists',
  'user_already_exists',
]);

/** Maps upstream failures to a fixed, localized message key. Raw provider text is never returned. */
export function safeAuthFeedback(
  error: unknown,
  context: AuthErrorContext,
): AuthFeedback {
  const code = authErrorCode(error);

  if (canceledCodes.has(code)) return { kind: 'silent' };
  if (context === 'register' && existingIdentityCodes.has(code)) {
    return { kind: 'success', key: 'auth.checkEmail' };
  }
  if (isNetworkError(error)) return { kind: 'error', key: 'auth.networkError' };
  if (rateLimitCodes.has(code)) return { kind: 'error', key: 'auth.tooManyAttempts' };
  if (unavailableCodes.has(code) || context === 'configuration') {
    return { kind: 'error', key: 'auth.methodUnavailable' };
  }
  if (expiredFlowCodes.has(code)) return { kind: 'error', key: 'auth.sessionExpired' };
  if (code === 'weak_password') return { kind: 'error', key: 'auth.weakPassword' };
  if (
    context === 'login' &&
    ['email_not_confirmed', 'invalid_credentials', 'user_banned', 'user_not_found'].includes(code)
  ) {
    return { kind: 'error', key: 'auth.signInFailed' };
  }

  return { kind: 'error', key: 'auth.genericError' };
}

export class AuthOperationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Authentication operation failed');
    this.name = 'AuthOperationError';
    this.code = code;
  }
}
