export type ReleaseErrorCode =
  | 'authentication'
  | 'permission'
  | 'bluetooth-off'
  | 'platform'
  | 'configuration'
  | 'not-found'
  | 'unsupported'
  | 'recovery'
  | 'owner'
  | 'connection'
  | 'unavailable';

export function safeReleaseErrorCode(error: unknown): ReleaseErrorCode {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (value.code === 'AUTH_TOKEN_UNAVAILABLE' || value.status === 401) return 'authentication';
  if (value.code === 'BLUETOOTH_PERMISSION_DENIED' || value.errorCode === 101) return 'permission';
  if (value.code === 'BLUETOOTH_POWERED_OFF' || value.errorCode === 102) return 'bluetooth-off';
  if (value.code === 'BLUETOOTH_UNSUPPORTED' || value.errorCode === 100) return 'platform';
  if (value.code === 'RELEASE_NOT_FOUND') return 'not-found';
  if (value.code === 'AUTHENTICATED_RESET_UNSUPPORTED') return 'unsupported';
  if (value.code === 'RECOVERY_REQUIRED' || value.code === 'TAG_RESET_FAILED') return 'recovery';
  if (value.status === 403 || value.status === 404 || value.code === 'SERIAL_MISMATCH') return 'owner';
  if (value.code === 'RING_CONFIGURATION' || value.code === 'API_CONFIGURATION') {
    return 'configuration';
  }
  if (
    value.code === 'NETWORK_ERROR' ||
    value.code === 'REQUEST_TIMEOUT' ||
    value.code === 'RELEASE_EXPIRED' ||
    value.errorCode === 200 ||
    value.errorCode === 201
  ) return 'connection';
  return 'unavailable';
}
