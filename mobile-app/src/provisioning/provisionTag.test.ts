import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { BleManager, Device } from '@sfourdrinier/react-native-ble-plx';

import { PinqevaProvisioningClient, type DeviceClaimStart } from './api.ts';
import {
  ADVERTISEMENT_KEY_UUID,
  DEVICE_IDENTIFIER_UUID,
  KEY_FINGERPRINT_UUID,
  PINKEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID,
  PROVISIONING_STATUS_UUID,
  TAG_AUTHORIZATION_PROOF_UUID,
  TAG_CHALLENGE_UUID,
  TAG_CONTROL_KEY_UUID,
  encodeBase64Url,
  toBleBase64,
} from './protocol.ts';
import { TagProvisioner } from './provisionTag.ts';

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value).digest());
}

test('bridges a tag challenge to the API, installs one key allocation, and completes ownership', async () => {
  const serialNumber = 'PKV-AABBCCDDEEFF';
  const challenge = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const advertisementKey = Uint8Array.from({ length: 28 }, (_, index) => 0xa0 + index);
  const advertisementHash = sha256(advertisementKey);
  const controlKey = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
  const authorizationProof = Uint8Array.from({ length: 32 }, (_, index) => 0x60 + index);
  const completionToken = Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index);
  const events: string[] = [];
  let storedFingerprint = new Uint8Array(32);

  const claim: DeviceClaimStart = {
    session_id: '11111111-1111-4111-8111-111111111111',
    serial_number: serialNumber,
    protocol_version: 1,
    tag_action: 'write_key',
    advertisement_key_base64url: encodeBase64Url(advertisementKey),
    advertisement_key_sha256_base64url: encodeBase64Url(advertisementHash),
    tag_authorization_proof_base64url: encodeBase64Url(authorizationProof),
    claim_completion_token_base64url: encodeBase64Url(completionToken),
    tag_control_key_base64url: encodeBase64Url(controlKey),
    expires_at: '2099-01-01T00:00:00.000Z',
    claim_deadline: '2099-01-02T00:00:00.000Z',
  };
  const completed = {
    device_id: '22222222-2222-4222-8222-222222222222',
    serial_number: serialNumber,
    status: 'suspended' as const,
    claimed_at: '2099-01-01T00:00:00.000Z',
    next_action: 'install_signed_entitlement' as const,
  };

  const backend = {
    startDeviceClaim: async (input: Parameters<PinqevaProvisioningClient['startDeviceClaim']>[0]) => {
      events.push('api:start');
      assert.equal(input.serialNumber, serialNumber);
      assert.equal(input.tagChallengeBase64url, encodeBase64Url(challenge));
      assert.equal(input.tagAdvertisementKeySha256Base64url, null);
      return claim;
    },
    completeDeviceClaim: async (input: Parameters<PinqevaProvisioningClient['completeDeviceClaim']>[0]) => {
      events.push('api:complete');
      assert.equal(input.claim.session_id, claim.session_id);
      assert.equal(input.tagAdvertisementKeySha256Base64url, encodeBase64Url(advertisementHash));
      return completed;
    },
  } as unknown as PinqevaProvisioningClient;

  const device = {
    id: 'peripheral-1',
    discoverAllServicesAndCharacteristics: async () => {
      events.push('ble:discover');
      return device;
    },
    requestMTU: async () => device,
    readCharacteristicForService: async (_service: string, characteristic: string) => {
      if (characteristic === PROTOCOL_INFO_UUID) {
        events.push('ble:read:protocol');
        return { value: toBleBase64(Uint8Array.of(1, 3, 0, 1, 0x30, 0)) };
      }
      if (characteristic === DEVICE_IDENTIFIER_UUID) {
        events.push('ble:read:identity');
        return { value: toBleBase64(new TextEncoder().encode(serialNumber)) };
      }
      if (characteristic === KEY_FINGERPRINT_UUID) {
        events.push('ble:read:fingerprint');
        return { value: toBleBase64(storedFingerprint) };
      }
      if (characteristic === TAG_CHALLENGE_UUID) {
        events.push('ble:read:challenge');
        return { value: toBleBase64(challenge) };
      }
      if (characteristic === PROVISIONING_STATUS_UUID) {
        events.push('ble:read:status');
        return { value: toBleBase64(Uint8Array.of(0x04, 0x00)) };
      }
      throw new Error(`Unexpected read ${characteristic}`);
    },
    writeCharacteristicWithResponseForService: async (
      _service: string,
      characteristic: string,
      value: string,
    ) => {
      if (characteristic === TAG_AUTHORIZATION_PROOF_UUID) {
        events.push('ble:write:authorization');
        assert.equal(value, toBleBase64(authorizationProof));
      } else if (characteristic === TAG_CONTROL_KEY_UUID) {
        events.push('ble:write:control');
        assert.equal(value, toBleBase64(controlKey));
      } else if (characteristic === ADVERTISEMENT_KEY_UUID) {
        events.push('ble:write:advertisement');
        assert.equal(value, toBleBase64(advertisementKey));
        storedFingerprint = advertisementHash;
      } else {
        throw new Error(`Unexpected write ${characteristic}`);
      }
      return device;
    },
    monitorCharacteristicForService: () => ({ remove() {} }),
  } as unknown as Device;

  const ble = {
    connectToDevice: async (
      peripheralId: string,
      options?: { autoConnect?: boolean; timeout?: number },
    ) => {
      events.push(`ble:connect:${peripheralId}`);
      assert.deepEqual(options, { autoConnect: false, timeout: 15_000 });
      return device;
    },
    cancelDeviceConnection: async () => {
      events.push('ble:disconnect');
      return device;
    },
  } as unknown as BleManager;

  const result = await new TagProvisioner(ble, backend).provision({
    peripheralId: 'peripheral-1',
    idempotencyKey: 'provision:test-bridge',
  });

  assert.deepEqual(result, completed);
  assert.deepEqual(events, [
    'ble:connect:peripheral-1',
    'ble:discover',
    'ble:read:protocol',
    'ble:read:identity',
    'ble:read:fingerprint',
    'ble:read:challenge',
    'api:start',
    'ble:write:authorization',
    'ble:write:control',
    'ble:write:advertisement',
    'ble:read:status',
    'ble:read:fingerprint',
    'api:complete',
    'ble:disconnect',
  ]);
});
