import * as SecureStore from 'expo-secure-store';

import type { DeviceReleaseStart } from './api';

export type PendingDeviceRelease = Pick<
  DeviceReleaseStart,
  | 'release_id'
  | 'device_id'
  | 'serial_number'
  | 'release_completion_token_base64url'
  | 'expires_at'
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERIAL_PATTERN = /^PKV-[0-9A-F]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function storageKey(deviceId: string): string {
  return `pinkeva.pending-release.${deviceId.toLowerCase()}`;
}

export function parsePendingDeviceRelease(
  value: unknown,
  expectedDeviceId: string,
): PendingDeviceRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pending = value as Record<string, unknown>;
  if (
    typeof pending.release_id !== 'string' ||
    !UUID_PATTERN.test(pending.release_id) ||
    typeof pending.device_id !== 'string' ||
    pending.device_id.toLowerCase() !== expectedDeviceId.toLowerCase() ||
    typeof pending.serial_number !== 'string' ||
    !SERIAL_PATTERN.test(pending.serial_number) ||
    typeof pending.release_completion_token_base64url !== 'string' ||
    !TOKEN_PATTERN.test(pending.release_completion_token_base64url) ||
    typeof pending.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(pending.expires_at))
  ) return null;
  return {
    release_id: pending.release_id.toLowerCase(),
    device_id: expectedDeviceId.toLowerCase(),
    serial_number: pending.serial_number,
    release_completion_token_base64url: pending.release_completion_token_base64url,
    expires_at: pending.expires_at,
  };
}

export async function loadPendingDeviceRelease(
  deviceId: string,
): Promise<PendingDeviceRelease | null> {
  const raw = await SecureStore.getItemAsync(storageKey(deviceId));
  if (!raw) return null;
  try {
    const parsed = parsePendingDeviceRelease(JSON.parse(raw), deviceId);
    if (parsed) return parsed;
  } catch {
    // Invalid encrypted state cannot be trusted as proof of a completed tag reset.
  }
  await SecureStore.deleteItemAsync(storageKey(deviceId));
  return null;
}

export async function savePendingDeviceRelease(
  release: DeviceReleaseStart,
): Promise<void> {
  const pending = parsePendingDeviceRelease(release, release.device_id);
  if (!pending) throw new Error('INVALID_PENDING_RELEASE');
  await SecureStore.setItemAsync(storageKey(pending.device_id), JSON.stringify(pending), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearPendingDeviceRelease(deviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(deviceId));
}
