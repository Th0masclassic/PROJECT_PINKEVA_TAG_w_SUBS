import type { DeviceReleaseStart } from './api';

export type PendingDeviceRelease = Pick<
  DeviceReleaseStart,
  | 'release_id'
  | 'device_id'
  | 'serial_number'
  | 'release_completion_token_base64url'
  | 'expires_at'
>;

// Secure release is unsupported by the web/default radio implementation. These
// no-op fallbacks keep non-native bundles from persisting completion secrets in
// ordinary browser storage.
export async function loadPendingDeviceRelease(
  _deviceId: string,
): Promise<PendingDeviceRelease | null> {
  return null;
}

export async function savePendingDeviceRelease(
  _release: DeviceReleaseStart,
): Promise<void> {
  return undefined;
}

export async function clearPendingDeviceRelease(_deviceId: string): Promise<void> {
  return undefined;
}
