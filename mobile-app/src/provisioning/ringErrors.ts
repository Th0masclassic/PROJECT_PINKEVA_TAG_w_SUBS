export type RingErrorCode = 'authentication' | 'permission' | 'bluetooth-off' | 'platform' |
  'configuration' | 'not-found' | 'unsupported' | 'owner' | 'connection' | 'unavailable';

/** Native/backend diagnostics never become user-visible strings. */
export function safeRingErrorCode(error: unknown): RingErrorCode {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (value.code === 'AUTH_TOKEN_UNAVAILABLE' || value.status === 401) return 'authentication';
  if (value.code === 'BLUETOOTH_PERMISSION_DENIED' || value.errorCode === 101) return 'permission';
  if (value.code === 'BLUETOOTH_POWERED_OFF' || value.errorCode === 102) return 'bluetooth-off';
  if (value.code === 'BLUETOOTH_UNSUPPORTED' || value.errorCode === 100) return 'platform';
  if (value.code === 'RING_NOT_FOUND') return 'not-found';
  if (value.code === 'RING_UNSUPPORTED') return 'unsupported';
  if (value.status === 403 || value.status === 404) return 'owner';
  if (value.code === 'RING_CONFIGURATION') return 'configuration';
  if (value.code === 'NETWORK_ERROR' || value.code === 'REQUEST_TIMEOUT' ||
      value.code === 'RING_DISCONNECTED' || value.code === 'RING_STATUS_TIMEOUT' ||
      value.errorCode === 200 || value.errorCode === 201) return 'connection';
  return 'unavailable';
}
