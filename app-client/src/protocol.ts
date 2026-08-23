import { fromByteArray, toByteArray } from "base64-js";

export const PINQEVA_SERVICE_UUID = "a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01";
export const PROTOCOL_INFO_UUID = "a6f0f001-3e4d-4b1a-9c2e-72d24c8f0a01";
export const DEVICE_IDENTIFIER_UUID = "a6f0f002-3e4d-4b1a-9c2e-72d24c8f0a01";
export const ADVERTISEMENT_KEY_UUID = "a6f0f003-3e4d-4b1a-9c2e-72d24c8f0a01";
export const PROVISIONING_STATUS_UUID = "a6f0f004-3e4d-4b1a-9c2e-72d24c8f0a01";
export const KEY_FINGERPRINT_UUID = "a6f0f005-3e4d-4b1a-9c2e-72d24c8f0a01";
export const TAG_CONTROL_KEY_UUID = "a6f0f006-3e4d-4b1a-9c2e-72d24c8f0a01";
export const AUTHENTICATED_RESET_UUID = "a6f0f007-3e4d-4b1a-9c2e-72d24c8f0a01";
export const TAG_CHALLENGE_UUID = "a6f0f008-3e4d-4b1a-9c2e-72d24c8f0a01";
export const TAG_AUTHORIZATION_PROOF_UUID = "a6f0f009-3e4d-4b1a-9c2e-72d24c8f0a01";

export const ADVERTISEMENT_KEY_LENGTH = 28;
export const KEY_FINGERPRINT_LENGTH = 32;
export const TAG_CONTROL_KEY_LENGTH = 32;
export const TAG_CHALLENGE_LENGTH = 32;
export const TAG_AUTHORIZATION_PROOF_LENGTH = 32;
export const RESET_COMMAND_LENGTH = 64;
export const TAG_AUTHORIZATION_CAPABILITY = 0x0010;
export const READY_SUCCESS = Uint8Array.of(0x04, 0x00);

export type ProtocolInformation = {
  protocolMajor: number;
  protocolMinor: number;
  firmwareMajor: number;
  firmwareMinor: number;
  capabilities: number;
};

export function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return toByteArray(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
}

export function encodeBase64Url(value: Uint8Array): string {
  return fromByteArray(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function toBleBase64(value: Uint8Array): string {
  return fromByteArray(value);
}

export function decodeBleBase64(value: string | null): Uint8Array {
  if (value === null) {
    throw new ProvisioningClientError("EMPTY_CHARACTERISTIC", "Tag returned an empty value");
  }
  return toByteArray(value);
}

export function parseProtocolInformation(value: Uint8Array): ProtocolInformation {
  if (value.length !== 6) {
    throw new ProvisioningClientError(
      "INVALID_PROTOCOL_INFO",
      `Expected 6 protocol bytes, received ${value.length}`,
    );
  }
  return {
    protocolMajor: value[0],
    protocolMinor: value[1],
    firmwareMajor: value[2],
    firmwareMinor: value[3],
    capabilities: value[4] | (value[5] << 8),
  };
}

export function decodeDeviceIdentifier(value: Uint8Array): string {
  const serial = new TextDecoder("utf-8", { fatal: true }).decode(value).toUpperCase();
  if (!/^PKV-[0-9A-F]{12}$/.test(serial)) {
    throw new ProvisioningClientError(
      "INVALID_DEVICE_ID",
      "The connected peripheral is not a valid Pinqeva tag",
    );
  }
  return serial;
}

export function provisioningStatusIsReady(value: Uint8Array): boolean {
  if (value.length !== 2) {
    throw new ProvisioningClientError(
      "INVALID_TAG_STATUS",
      "Tag returned an invalid provisioning status",
    );
  }
  if (value[0] === READY_SUCCESS[0] && value[1] === READY_SUCCESS[1]) {
    return true;
  }
  if (value[0] === 0x7f) {
    throw new ProvisioningClientError(
      "TAG_REJECTED_KEY",
      `Tag rejected provisioning with result 0x${value[1].toString(16).padStart(2, "0")}`,
    );
  }
  return false;
}

export function decodeTagKeyFingerprint(value: Uint8Array): Uint8Array | null {
  if (value.length !== KEY_FINGERPRINT_LENGTH) {
    throw new ProvisioningClientError(
      "INVALID_TAG_FINGERPRINT",
      `Expected ${KEY_FINGERPRINT_LENGTH} fingerprint bytes, received ${value.length}`,
    );
  }
  if (value.every((byte) => byte === 0)) return null;
  return value;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export class ProvisioningClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningClientError";
  }
}
