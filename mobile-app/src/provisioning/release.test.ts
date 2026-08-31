import assert from 'node:assert/strict';
import test from 'node:test';
import type { BleManager, Device } from '@sfourdrinier/react-native-ble-plx';

import { PinqevaProvisioningClient } from './api.ts';
import {
  AUTHENTICATED_RESET_UUID,
  DEVICE_IDENTIFIER_UUID,
  FINDING_NETWORK_UUID,
  GOOGLE_KEY_FINGERPRINT_UUID,
  KEY_FINGERPRINT_UUID,
  PINKEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID,
  TAG_AUTHORIZATION_PROOF_UUID,
  TAG_CHALLENGE_UUID,
  encodeBase64Url,
  toBleBase64,
} from './protocol.ts';
import { TagProvisioner } from './provisionTag.ts';

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERIAL = 'PKV-AABBCCDDEEFF';
const PROOF = new Uint8Array(32).fill(0x31);
const RESET = new Uint8Array(64).fill(0x72);
const TOKEN = new Uint8Array(32).fill(0x54);

function releaseBackendResponse() {
  return {
    release_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    device_id: DEVICE_ID,
    serial_number: SERIAL,
    tag_authorization_proof_base64url: encodeBase64Url(PROOF),
    reset_command_base64url: encodeBase64Url(RESET),
    release_completion_token_base64url: encodeBase64Url(TOKEN),
    expires_at: '2099-01-01T00:00:00Z',
  };
}

function releaseCompletedResponse() {
  return {
    device_id: DEVICE_ID,
    serial_number: SERIAL,
    status: 'unprovisioned',
    released_at: '2026-08-31T12:00:00Z',
    cancelled_subscriptions: 0,
    provider_cancellations_queued: 0,
    next_action: 'ready_for_new_owner',
  };
}

function radioHarness(options: { serial?: string; eraseSucceeds?: boolean } = {}) {
  const writes: Array<{ characteristic: string; bytes: Uint8Array }> = [];
  let erased = false;
  const initialFingerprint = new Uint8Array(32).fill(0x41);
  const initialGoogleFingerprint = new Uint8Array(32).fill(0x51);
  const challenge = new Uint8Array(32).fill(0x61);
  const device = {
    id: 'peripheral-1',
    discoverAllServicesAndCharacteristics: async () => device,
    requestMTU: async () => device,
    readCharacteristicForService: async (service: string, characteristic: string) => {
      assert.equal(service, PINKEVA_SERVICE_UUID);
      const values: Record<string, Uint8Array> = {
        [PROTOCOL_INFO_UUID]: Uint8Array.of(1, 9, 0, 6, 0x18, 0x01),
        [DEVICE_IDENTIFIER_UUID]: new TextEncoder().encode(options.serial ?? SERIAL),
        [KEY_FINGERPRINT_UUID]: erased ? new Uint8Array(32) : initialFingerprint,
        [GOOGLE_KEY_FINGERPRINT_UUID]: erased ? new Uint8Array(32) : initialGoogleFingerprint,
        [FINDING_NETWORK_UUID]: erased ? Uint8Array.of(0) : Uint8Array.of(1),
        [TAG_CHALLENGE_UUID]: challenge,
      };
      const value = values[characteristic];
      assert.ok(value, `unexpected characteristic read ${characteristic}`);
      return { value: toBleBase64(value) };
    },
    writeCharacteristicWithResponseForService: async (
      service: string,
      characteristic: string,
      value: string,
    ) => {
      assert.equal(service, PINKEVA_SERVICE_UUID);
      const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
      writes.push({ characteristic, bytes });
      if (characteristic === AUTHENTICATED_RESET_UUID && options.eraseSucceeds !== false) {
        erased = true;
      }
      return {};
    },
  } as unknown as Device;
  const cancelled: string[] = [];
  const ble = {
    connectToDevice: async (id: string) => {
      assert.equal(id, 'peripheral-1');
      return device;
    },
    cancelDeviceConnection: async (id: string) => {
      cancelled.push(id);
      return device;
    },
  } as unknown as BleManager;
  return { ble, writes, cancelled };
}

test('secure release verifies the tag, erases it, then completes the backend phase', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(
      url.endsWith('/release/complete') ? releaseCompletedResponse() : releaseBackendResponse(),
    ), { status: url.endsWith('/release/complete') ? 200 : 201 });
  }) as typeof fetch;
  const { ble, writes, cancelled } = radioHarness();
  const backend = new PinqevaProvisioningClient(
    { baseUrl: 'https://api.example.test' },
    async () => 'access-token',
  );
  const progress: string[] = [];
  const lifecycle: string[] = [];

  try {
    const released = await new TagProvisioner(ble, backend).release({
      peripheralId: 'peripheral-1',
      deviceId: DEVICE_ID,
      expectedSerialNumber: SERIAL,
      idempotencyKey: 'release:test-request-0001',
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
      onResetVerified: async (pending) => {
        assert.equal(pending.device_id, DEVICE_ID);
        assert.equal(pending.release_completion_token_base64url, encodeBase64Url(TOKEN));
        lifecycle.push('reset-verified');
      },
      onCompleted: async () => {
        lifecycle.push('completed');
      },
    });

    assert.equal(released.status, 'unprovisioned');
    assert.deepEqual(progress, [
      'connecting',
      'verifying',
      'authorizing',
      'erasing',
      'finalizing',
    ]);
    assert.deepEqual(writes.map((write) => write.characteristic), [
      TAG_AUTHORIZATION_PROOF_UUID,
      AUTHENTICATED_RESET_UUID,
    ]);
    assert.deepEqual(writes[0]?.bytes, PROOF);
    assert.deepEqual(writes[1]?.bytes, RESET);
    assert.equal(calls[0]?.url, `https://api.example.test/v1/devices/${DEVICE_ID}/release`);
    assert.equal(calls[1]?.url, `https://api.example.test/v1/devices/${DEVICE_ID}/release/complete`);
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['Idempotency-Key'], 'release:test-request-0001');
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      release_id: releaseBackendResponse().release_id,
      serial_number: SERIAL,
      tag_key_state: 'empty',
      tag_google_key_state: 'empty',
      tag_finding_network_state: 'empty',
      release_completion_token_base64url: encodeBase64Url(TOKEN),
    });
    assert.deepEqual(cancelled, ['peripheral-1']);
    assert.deepEqual(lifecycle, ['reset-verified', 'completed']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a verified reset can be persisted before a failed backend completion retry', async () => {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/release/complete')) {
      completionCalls += 1;
      return new Response(JSON.stringify({ code: 'temporarily_unavailable' }), { status: 503 });
    }
    return new Response(JSON.stringify(releaseBackendResponse()), { status: 201 });
  }) as typeof fetch;
  const { ble } = radioHarness();
  let saved = false;
  let cleared = false;

  try {
    await assert.rejects(() => new TagProvisioner(
      ble,
      new PinqevaProvisioningClient({ baseUrl: 'https://api.example.test' }, async () => 'token'),
    ).release({
      peripheralId: 'peripheral-1',
      deviceId: DEVICE_ID,
      expectedSerialNumber: SERIAL,
      idempotencyKey: 'release:test-request-0004',
      signal: new AbortController().signal,
      onResetVerified: async () => { saved = true; },
      onCompleted: async () => { cleared = true; },
    }));
    assert.equal(completionCalls, 1);
    assert.equal(saved, true);
    assert.equal(cleared, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a different physical serial is rejected before owner authorization', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response();
  }) as typeof fetch;
  const { ble } = radioHarness({ serial: 'PKV-001122334455' });
  try {
    await assert.rejects(
      () => new TagProvisioner(
        ble,
        new PinqevaProvisioningClient({ baseUrl: 'https://api.example.test' }, async () => 'token'),
      ).release({
        peripheralId: 'peripheral-1',
        deviceId: DEVICE_ID,
        expectedSerialNumber: SERIAL,
        idempotencyKey: 'release:test-request-0002',
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'SERIAL_MISMATCH'),
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('backend completion is never claimed when the tag does not confirm erasure', async () => {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/release/complete')) completionCalls += 1;
    return new Response(JSON.stringify(
      url.endsWith('/release/complete') ? releaseCompletedResponse() : releaseBackendResponse(),
    ), { status: 200 });
  }) as typeof fetch;
  const { ble } = radioHarness({ eraseSucceeds: false });
  try {
    await assert.rejects(
      () => new TagProvisioner(
        ble,
        new PinqevaProvisioningClient({ baseUrl: 'https://api.example.test' }, async () => 'token'),
      ).release({
        peripheralId: 'peripheral-1',
        deviceId: DEVICE_ID,
        expectedSerialNumber: SERIAL,
        idempotencyKey: 'release:test-request-0003',
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'TAG_RESET_FAILED'),
    );
    assert.equal(completionCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
