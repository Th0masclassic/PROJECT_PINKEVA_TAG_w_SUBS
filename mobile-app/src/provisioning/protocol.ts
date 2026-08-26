import { fromByteArray, toByteArray } from 'base64-js';

export const PINKEVA_SERVICE_UUID = 'a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01';
export const PROTOCOL_INFO_UUID = 'a6f0f001-3e4d-4b1a-9c2e-72d24c8f0a01';
export const DEVICE_IDENTIFIER_UUID = 'a6f0f002-3e4d-4b1a-9c2e-72d24c8f0a01';
export const ADVERTISEMENT_KEY_UUID = 'a6f0f003-3e4d-4b1a-9c2e-72d24c8f0a01';
export const PROVISIONING_STATUS_UUID = 'a6f0f004-3e4d-4b1a-9c2e-72d24c8f0a01';
export const KEY_FINGERPRINT_UUID = 'a6f0f005-3e4d-4b1a-9c2e-72d24c8f0a01';
export const TAG_CONTROL_KEY_UUID = 'a6f0f006-3e4d-4b1a-9c2e-72d24c8f0a01';
export const TAG_CHALLENGE_UUID = 'a6f0f008-3e4d-4b1a-9c2e-72d24c8f0a01';
export const TAG_AUTHORIZATION_PROOF_UUID = 'a6f0f009-3e4d-4b1a-9c2e-72d24c8f0a01';
export const SUBSCRIPTION_ENTITLEMENT_UUID = 'a6f0f00a-3e4d-4b1a-9c2e-72d24c8f0a01';
export const UTC_TIME_UUID = 'a6f0f00b-3e4d-4b1a-9c2e-72d24c8f0a01';
export const FIRMWARE_MANIFEST_UUID = 'a6f0f00c-3e4d-4b1a-9c2e-72d24c8f0a01';
export const FIRMWARE_DATA_UUID = 'a6f0f00d-3e4d-4b1a-9c2e-72d24c8f0a01';
export const FIRMWARE_CONTROL_UUID = 'a6f0f00e-3e4d-4b1a-9c2e-72d24c8f0a01';
export const FIRMWARE_STATUS_UUID = 'a6f0f00f-3e4d-4b1a-9c2e-72d24c8f0a01';
export const FIRMWARE_VERSION_UUID = 'a6f0f010-3e4d-4b1a-9c2e-72d24c8f0a01';

export const ADVERTISEMENT_KEY_LENGTH = 28;
export const KEY_FINGERPRINT_LENGTH = 32;
export const TAG_CONTROL_KEY_LENGTH = 32;
export const TAG_CHALLENGE_LENGTH = 32;
export const TAG_AUTHORIZATION_PROOF_LENGTH = 32;
export const SUBSCRIPTION_ENTITLEMENT_LENGTH = 135;
export const UTC_TIME_LENGTH = 8;
export const FIRMWARE_MANIFEST_LENGTH = 115;
export const FIRMWARE_STATUS_LENGTH = 6;
export const FIRMWARE_VERSION_LENGTH = 3;
export const TAG_AUTHORIZATION_CAPABILITY = 0x0010;
export const NON_BONDING_SETUP_CAPABILITY = 0x0020;
export const UTC_TIME_SYNC_CAPABILITY = 0x0040;
export const FIRMWARE_UPDATE_CAPABILITY = 0x0080;
export const READY_SUCCESS = Uint8Array.of(0x04, 0x00);
export const PINKEVA_SERIAL_PATTERN = /^PKV-[0-9A-F]{12}$/;

export type ProtocolInformation = {
  protocolMajor: number;
  protocolMinor: number;
  firmwareMajor: number;
  firmwareMinor: number;
  capabilities: number;
};

export class ProvisioningClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProvisioningClientError';
    this.code = code;
  }
}

export function decodeBase64Url(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return toByteArray(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  } catch {
    throw new ProvisioningClientError('INVALID_BACKEND_VALUE', 'Invalid encoded value');
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  return fromByteArray(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function toBleBase64(value: Uint8Array): string {
  return fromByteArray(value);
}

/** Encode a JavaScript instant as an unsigned, big-endian Unix UTC value. */
export function encodeUtcUnixSeconds(value: Date = new Date()): Uint8Array {
  let seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ProvisioningClientError('INVALID_DEVICE_TIME', 'Phone UTC time is invalid');
  }
  const encoded = new Uint8Array(UTC_TIME_LENGTH);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = seconds % 256;
    seconds = Math.floor(seconds / 256);
  }
  return encoded;
}

export function decodeBleBase64(value: string | null): Uint8Array {
  if (value === null) {
    throw new ProvisioningClientError('EMPTY_CHARACTERISTIC', 'Tag returned no value');
  }
  try {
    return toByteArray(value);
  } catch {
    throw new ProvisioningClientError('INVALID_CHARACTERISTIC', 'Tag returned invalid data');
  }
}

export function normalizeAdvertisedSerial(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const serial = value.trim().toUpperCase();
  return PINKEVA_SERIAL_PATTERN.test(serial) ? serial : null;
}

export function parseProtocolInformation(value: Uint8Array): ProtocolInformation {
  if (value.length !== 6) {
    throw new ProvisioningClientError('INVALID_PROTOCOL_INFO', 'Unexpected protocol data');
  }
  return {
    protocolMajor: value[0],
    protocolMinor: value[1],
    firmwareMajor: value[2],
    firmwareMinor: value[3],
    capabilities: value[4] | (value[5] << 8),
  };
}

export function parseFirmwareVersion(value: Uint8Array): string {
  if (value.length !== FIRMWARE_VERSION_LENGTH) {
    throw new ProvisioningClientError('INVALID_FIRMWARE_VERSION', 'Unexpected firmware version');
  }
  return `${value[0]}.${value[1]}.${value[2]}`;
}

export type FirmwareStatus = {
  state: number;
  result: number;
  receivedBytes: number;
};

export function parseFirmwareStatus(value: Uint8Array): FirmwareStatus {
  if (value.length !== FIRMWARE_STATUS_LENGTH) {
    throw new ProvisioningClientError('INVALID_FIRMWARE_STATUS', 'Unexpected firmware status');
  }
  return {
    state: value[0],
    result: value[1],
    receivedBytes:
      value[2] * 0x1000000 +
      (value[3] << 16) +
      (value[4] << 8) +
      value[5],
  };
}

export function decodeDeviceIdentifier(value: Uint8Array): string {
  if (value.some((byte) => byte > 0x7f)) {
    throw new ProvisioningClientError('INVALID_DEVICE_ID', 'Unexpected tag identifier');
  }
  const serial = String.fromCharCode(...value).toUpperCase();
  if (!PINKEVA_SERIAL_PATTERN.test(serial)) {
    throw new ProvisioningClientError('INVALID_DEVICE_ID', 'Unexpected tag identifier');
  }
  return serial;
}

export function provisioningStatusIsReady(value: Uint8Array): boolean {
  if (value.length !== 2) {
    throw new ProvisioningClientError('INVALID_TAG_STATUS', 'Unexpected tag status');
  }
  if (value[0] === READY_SUCCESS[0] && value[1] === READY_SUCCESS[1]) return true;
  if (value[0] === 0x7f) {
    throw new ProvisioningClientError('TAG_REJECTED_KEY', 'Tag rejected setup');
  }
  return false;
}

export function decodeTagKeyFingerprint(value: Uint8Array): Uint8Array | null {
  if (value.length !== KEY_FINGERPRINT_LENGTH) {
    throw new ProvisioningClientError('INVALID_TAG_FINGERPRINT', 'Unexpected key fingerprint');
  }
  return value.every((byte) => byte === 0) ? null : value;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
