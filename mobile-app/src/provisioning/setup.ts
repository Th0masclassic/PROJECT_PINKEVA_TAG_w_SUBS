import type { TranslationKey } from '../i18n';

export type TagSetupErrorCode =
  | 'authentication'
  | 'bluetooth-off'
  | 'bluetooth-permission'
  | 'bluetooth-unsupported'
  | 'configuration'
  | 'connection'
  | 'incompatible'
  | 'recovery-required'
  | 'tag-busy'
  | 'tag-rejected'
  | 'tag-unavailable'
  | 'timeout'
  | 'unavailable';

export function safeTagSetupErrorCode(error: unknown): TagSetupErrorCode {
  const name = error instanceof Error ? error.name : '';
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;

  if (name === 'TagRadioError') {
    if (code === 'BLUETOOTH_POWERED_OFF') return 'bluetooth-off';
    if (code === 'BLUETOOTH_PERMISSION_DENIED') return 'bluetooth-permission';
    if (code === 'BLUETOOTH_UNSUPPORTED') return 'bluetooth-unsupported';
    if (code === 'BLUETOOTH_SCAN_FAILED') return 'connection';
    return 'unavailable';
  }

  if (name === 'ProvisioningApiError') {
    if (code === 'AUTH_TOKEN_UNAVAILABLE' || status === 401) {
      return 'authentication';
    }
    if (code === 'DEVICE_AUTHORIZATION_REJECTED') return 'tag-rejected';
    if (code === 'DEVICE_UNAVAILABLE') return 'tag-unavailable';
    if (code === 'SUBSCRIPTION_REQUIRED') return 'tag-rejected';
    if (code === 'ENTITLEMENT_UNAVAILABLE') return 'unavailable';
    if (code === 'FIRMWARE_UNAVAILABLE' || code === 'FIRMWARE_NOT_FOUND') return 'unavailable';
    if (code === 'FIRMWARE_UP_TO_DATE') return 'tag-busy';
    if (code === 'FIRMWARE_ACK_REJECTED') return 'recovery-required';
    if (code === 'TAG_NOT_READY') return 'tag-busy';
    if (code === 'PROVISIONING_IN_PROGRESS') return 'tag-busy';
    if (code === 'RECOVERY_REQUIRED' || code === 'SESSION_NOT_FOUND') {
      return 'recovery-required';
    }
    if (code === 'REQUEST_TIMEOUT') return 'timeout';
    if (code === 'NETWORK_ERROR') return 'connection';
    return 'unavailable';
  }

  if (name === 'ProvisioningClientError') {
    if (code === 'UNSUPPORTED_PROTOCOL' || code === 'INVALID_DEVICE_ID') {
      return 'incompatible';
    }
    if (code === 'SESSION_EXPIRED' || code === 'TAG_CONFIRMATION_TIMEOUT') {
      return 'timeout';
    }
    if (code === 'FIRMWARE_REBOOT_TIMEOUT') return 'timeout';
    if (
      code === 'TAG_REJECTED_KEY' ||
      code === 'TAG_KEY_MISMATCH' ||
      code === 'BACKEND_BINDING_MISMATCH'
    ) {
      return 'recovery-required';
    }
    return 'tag-rejected';
  }

  return 'connection';
}

export function tagSetupErrorTranslationKey(code: TagSetupErrorCode): TranslationKey {
  const keys: Record<TagSetupErrorCode, TranslationKey> = {
    authentication: 'pairing.errorAuthentication',
    'bluetooth-off': 'pairing.errorBluetoothOff',
    'bluetooth-permission': 'pairing.errorBluetoothPermission',
    'bluetooth-unsupported': 'pairing.errorBluetoothUnsupported',
    configuration: 'pairing.errorConfiguration',
    connection: 'pairing.errorConnection',
    incompatible: 'pairing.errorIncompatible',
    'recovery-required': 'pairing.errorRecovery',
    'tag-busy': 'pairing.errorBusy',
    'tag-rejected': 'pairing.errorRejected',
    'tag-unavailable': 'pairing.errorUnavailable',
    timeout: 'pairing.errorTimeout',
    unavailable: 'pairing.errorGeneric',
  };
  return keys[code];
}
