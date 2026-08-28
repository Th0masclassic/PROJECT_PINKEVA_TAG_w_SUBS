export type PermissionKey = 'notifications' | 'location' | 'bluetooth';

export type PermissionState = {
  key: PermissionKey;
  status: 'allowed' | 'not_allowed' | 'ask' | 'settings' | 'unavailable';
  detail: string;
};
