import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

import type { PermissionKey, PermissionState } from './types';

export type { PermissionKey, PermissionState } from './types';

function statusFor(value: 'granted' | 'denied' | 'undetermined'): PermissionState['status'] {
  if (value === 'granted') return 'allowed';
  if (value === 'undetermined') return 'ask';
  return 'not_allowed';
}

async function notificationState(): Promise<PermissionState> {
  const result = await Notifications.getPermissionsAsync();
  return {
    key: 'notifications',
    status: statusFor(result.status),
    detail:
      result.status === 'granted'
        ? 'Pinkeva can show account, tracker, and renewal updates.'
        : 'Choose when Pinkeva may show important tracker and account updates.',
  };
}

async function locationState(): Promise<PermissionState> {
  const result = await Location.getForegroundPermissionsAsync();
  return {
    key: 'location',
    status: statusFor(result.status),
    detail:
      result.status === 'granted'
        ? 'Used only while you ask to refresh a tracker location or view its history.'
        : 'Needed only when you ask Pinkeva to refresh a tracker location or history.',
  };
}

type AndroidPermission = Parameters<typeof PermissionsAndroid.check>[0];

function bluetoothPermissions(): AndroidPermission[] {
  if (Platform.OS !== 'android') return [];
  const permissions = PermissionsAndroid.PERMISSIONS as Record<string, string | undefined>;
  return [permissions.BLUETOOTH_SCAN, permissions.BLUETOOTH_CONNECT].filter(Boolean) as AndroidPermission[];
}

async function bluetoothState(): Promise<PermissionState> {
  if (Platform.OS === 'ios') {
    return {
      key: 'bluetooth',
      status: 'settings',
      detail: 'Bluetooth is managed by iPhone Settings and is used only when you connect or update a tag.',
    };
  }
  const permissions = bluetoothPermissions();
  if (!permissions.length) {
    return { key: 'bluetooth', status: 'unavailable', detail: 'Bluetooth permission is unavailable on this device.' };
  }
  const states = await Promise.all(permissions.map((permission) => PermissionsAndroid.check(permission)));
  return {
    key: 'bluetooth',
    status: states.every(Boolean) ? 'allowed' : 'ask',
    detail: states.every(Boolean)
      ? 'Used only to find, connect, configure, and securely update your Pinkeva tag.'
      : 'Needed only when you connect, configure, or securely update a Pinkeva tag.',
  };
}

export async function getAppPermissions(): Promise<PermissionState[]> {
  return Promise.all([notificationState(), locationState(), bluetoothState()]);
}

export async function requestAppPermission(key: PermissionKey): Promise<void> {
  if (key === 'notifications') {
    await Notifications.requestPermissionsAsync();
    return;
  }
  if (key === 'location') {
    await Location.requestForegroundPermissionsAsync();
    return;
  }
  if (Platform.OS === 'android') {
    const permissions = bluetoothPermissions();
    if (permissions.length) await PermissionsAndroid.requestMultiple(permissions);
    return;
  }
  await Linking.openSettings();
}

export async function openAppPermissionSettings(): Promise<void> {
  await Linking.openSettings();
}
