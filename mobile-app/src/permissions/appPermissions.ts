import type { PermissionKey, PermissionState } from './types';

export type { PermissionKey, PermissionState } from './types';

export async function getAppPermissions(): Promise<PermissionState[]> {
  return [
    { key: 'notifications', status: 'unavailable', detail: 'Available in the Pinkeva mobile app.' },
    { key: 'location', status: 'unavailable', detail: 'Available in the Pinkeva mobile app.' },
    { key: 'bluetooth', status: 'unavailable', detail: 'Available in the Pinkeva mobile app.' },
  ];
}

export async function requestAppPermission(_: PermissionKey): Promise<void> {}

export async function openAppPermissionSettings(): Promise<void> {}
