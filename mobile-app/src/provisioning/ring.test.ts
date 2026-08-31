import assert from 'node:assert/strict';
import test from 'node:test';
import type { BleManager, Device } from '@sfourdrinier/react-native-ble-plx';

import { PinqevaProvisioningClient, ProvisioningApiError } from './api.ts';
import { TagRinger } from './ring.ts';
import { safeRingErrorCode } from './ringErrors.ts';
import {
  DEVICE_IDENTIFIER_UUID, PINKEVA_SERVICE_UUID, PROTOCOL_INFO_UUID, RING_AUTHORIZATION_UUID,
  RING_CONTROL_UUID, RING_STATUS_UUID, TAG_CHALLENGE_UUID, decodeBleBase64,
  encodeBase64Url, parseRingStatus, toBleBase64,
} from './protocol.ts';

const serial = 'PKV-AABBCCDDEEFF';
const deviceId = '22222222-2222-4222-8222-222222222222';
const proof = new Uint8Array(32).fill(0x93);
const challenge = new Uint8Array(32).fill(0x42);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { wrongFirst?: boolean; capabilities?: number; challengeLength?: number; wrongBinding?: boolean; badProof?: boolean } = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const statuses: unknown[] = [];
  const errors: unknown[] = [];
  let sound = Uint8Array.of(0, 0);
  let notify: ((error: Error | null, characteristic: { value: string } | null) => void) | undefined;
  let disconnect: (() => void) | undefined;
  let authorizeWait: Promise<void> | undefined;
  let playWait: Promise<void> | undefined;
  let writeError = false;
  let scans = 0;
  const makeDevice = (id: string, identifier: string) => {
    const device = {
      id, localName: null, name: null,
      discoverAllServicesAndCharacteristics: async () => device,
      requestMTU: async () => device,
      readCharacteristicForService: async (service: string, characteristic: string) => {
        assert.equal(service, PINKEVA_SERVICE_UUID);
        const caps = options.capabilities ?? 0x0400;
        const values = {
          [DEVICE_IDENTIFIER_UUID]: new TextEncoder().encode(identifier),
          [PROTOCOL_INFO_UUID]: Uint8Array.of(1, 9, 0, 6, caps & 255, caps >> 8),
          [TAG_CHALLENGE_UUID]: challenge.subarray(0, options.challengeLength ?? 32),
          [RING_STATUS_UUID]: sound,
        };
        assert.ok(values[characteristic], `unexpected read ${characteristic}`);
        return { value: toBleBase64(values[characteristic]) };
      },
      writeCharacteristicWithResponseForService: async (_service: string, characteristic: string, encoded: string) => {
        if (characteristic === RING_AUTHORIZATION_UUID) {
          events.push('proof');
          assert.deepEqual(decodeBleBase64(encoded), proof);
        } else if (characteristic === RING_CONTROL_UUID) {
          const command = decodeBleBase64(encoded)[0];
          events.push(command === 1 ? 'play' : 'pause');
          if (writeError) throw new Error('private native diagnostics');
          if (command === 1 && playWait) await playWait;
          sound = command === 1 ? Uint8Array.of(1, 1) : Uint8Array.of(0, 0);
          notify?.(null, { value: toBleBase64(sound) });
        } else throw new Error(`unexpected write ${characteristic}`);
        return device;
      },
      monitorCharacteristicForService: (_service: string, characteristic: string, callback: typeof notify) => {
        assert.equal(characteristic, RING_STATUS_UUID);
        notify = callback;
        events.push('subscribe');
        return { remove: () => { events.push('unsubscribe'); notify = undefined; } };
      },
    };
    return device as unknown as Device;
  };
  const target = makeDevice('target', serial);
  const wrong = makeDevice('wrong', 'PKV-000000000000');
  const ble = {
    startDeviceScan: async (services: string[], _options: unknown, callback: (error: null, device: Device) => void) => {
      assert.deepEqual(services, [PINKEVA_SERVICE_UUID]);
      events.push('scan');
      callback(null, options.wrongFirst && scans++ === 0 ? wrong : target);
    },
    stopDeviceScan: async () => { events.push('stop-scan'); },
    connectToDevice: async (id: string, options: { autoConnect: boolean; timeout: number }) => {
      assert.equal(options.autoConnect, false);
      assert.ok(options.timeout <= 5_000);
      events.push(`connect:${id}`);
      return id === 'wrong' ? wrong : target;
    },
    cancelDeviceConnection: async (id: string) => { events.push(`disconnect:${id}`); return target; },
    onDeviceDisconnected: (_id: string, callback: () => void) => {
      disconnect = callback;
      return { remove: () => { events.push('unwatch-disconnect'); disconnect = undefined; } };
    },
  } as unknown as BleManager;
  const backend = {
    authorizeRing: async (input: { deviceId: string; serialNumber: string; tagChallengeBase64url: string }) => {
      events.push('authorize');
      assert.deepEqual(input, { deviceId, serialNumber: serial, tagChallengeBase64url: encodeBase64Url(challenge) });
      if (authorizeWait) await authorizeWait;
      return {
        device_id: options.wrongBinding ? 'another-device' : deviceId,
        serial_number: serial,
        ring_authorization_proof_base64url: encodeBase64Url(options.badProof ? proof.subarray(0, 4) : proof),
      };
    },
  } as unknown as PinqevaProvisioningClient;
  return {
    events, controller, statuses, errors, ble, backend,
    connect: () => new TagRinger(ble, backend).connectNearby({
      deviceId, serialNumber: serial, signal: controller.signal,
      onStatus: (status) => statuses.push(status), onError: (error) => errors.push(error),
    }),
    setAuthorizeWait: (value: Promise<void>) => { authorizeWait = value; },
    setPlayWait: (value: Promise<void>) => { playWait = value; },
    failWrite: () => { writeError = true; },
    disconnected: () => disconnect?.(),
    finishSound: () => { sound = Uint8Array.of(0, 0); notify?.(null, { value: toBleBase64(sound) }); },
  };
}

test('ring wire status rejects malformed values and unknown states/sources', () => {
  assert.deepEqual(parseRingStatus(Uint8Array.of(0, 0)), { playing: false, source: 'none' });
  assert.deepEqual(parseRingStatus(Uint8Array.of(1, 1)), { playing: true, source: 'owner' });
  assert.deepEqual(parseRingStatus(Uint8Array.of(1, 2)), { playing: true, source: 'dult' });
  for (const value of [[], [0], [1, 0], [0, 1], [2, 1], [1, 3], [0, 0, 0]]) {
    assert.throws(() => parseRingStatus(Uint8Array.from(value)), { code: 'INVALID_RING_STATUS' });
  }
});

test('ring verifies nearby candidate identity before authorizing; notifications end the session', async () => {
  const h = harness({ wrongFirst: true });
  const session = await h.connect();
  assert.ok(h.events.indexOf('disconnect:wrong') < h.events.indexOf('authorize'));
  assert.equal(h.events.filter((event) => event === 'authorize').length, 1);
  assert.equal(h.events.includes('play'), false);
  await session.play();
  assert.ok(h.events.indexOf('proof') < h.events.indexOf('play'));
  h.finishSound();
  await tick();
  assert.deepEqual(h.statuses.at(-1), { playing: false, source: 'none' });
  assert.ok(h.events.includes('unsubscribe'));
  assert.ok(h.events.includes('disconnect:target'));
  await assert.rejects(session.play(), { code: 'RING_DISCONNECTED' });
});

test('repeat Play is ignored and Pause follows an in-flight Play without restarting playback', async () => {
  const h = harness();
  let allowPlay!: () => void;
  h.setPlayWait(new Promise((resolve) => { allowPlay = resolve; }));
  const session = await h.connect();
  const playing = session.play();
  const repeated = session.play();
  assert.equal(playing, repeated);
  await tick();
  const pausing = session.pause();
  assert.equal(h.events.filter((event) => event === 'play').length, 1);
  allowPlay();
  await playing;
  await repeated;
  assert.deepEqual(await pausing, { playing: false, source: 'none' });
  assert.deepEqual(h.events.filter((event) => event === 'play' || event === 'pause'), ['play', 'pause']);
  assert.equal(h.errors.length, 0);
  await session.dispose();
});

test('repeat Play while already playing writes no second command', async () => {
  const h = harness();
  const session = await h.connect();
  await session.play();
  await session.play();
  assert.equal(h.events.filter((event) => event === 'play').length, 1);
  await session.dispose();
});

for (const [name, options, code] of [
  ['mismatched backend binding', { wrongBinding: true }, 'BACKEND_BINDING_MISMATCH'],
  ['old tracker firmware', { capabilities: 0x0300 }, 'RING_UNSUPPORTED'],
  ['invalid challenge', { challengeLength: 16 }, 'INVALID_TAG_CHALLENGE'],
  ['invalid proof', { badProof: true }, 'INVALID_BACKEND_AUTHORIZATION'],
] as const) {
  test(`ring rejects ${name} without writing control and disconnects`, async () => {
    const h = harness(options);
    await assert.rejects(h.connect(), { code });
    assert.equal(h.events.includes('proof'), false);
    assert.equal(h.events.includes('play'), false);
    assert.ok(h.events.includes('disconnect:target'));
  });
}

test('cancellation during backend authorization cannot later send proof or Play', async () => {
  const h = harness();
  let authorize!: () => void;
  h.setAuthorizeWait(new Promise((resolve) => { authorize = resolve; }));
  const connected = h.connect();
  await tick();
  assert.ok(h.events.includes('authorize'));
  h.controller.abort();
  authorize();
  await assert.rejects(connected, { code: 'RING_CANCELLED' });
  assert.equal(h.events.includes('proof'), false);
  assert.equal(h.events.includes('play'), false);
  assert.ok(h.events.includes('disconnect:target'));
});

test('BLE command failures and unexpected disconnects release subscriptions', async () => {
  const h = harness();
  const session = await h.connect();
  h.failWrite();
  await assert.rejects(session.play());
  assert.equal(h.errors.length, 1);
  assert.ok(h.events.includes('unsubscribe'));
  assert.ok(h.events.includes('disconnect:target'));
  const second = harness();
  await second.connect();
  second.disconnected();
  assert.equal(second.errors.length, 1);
  assert.ok(second.events.includes('unsubscribe'));
});

test('a bounded empty scan stops when no nearby tracker is found', async () => {
  let stopped = false;
  const ble = { startDeviceScan: async () => undefined, stopDeviceScan: async () => { stopped = true; } } as unknown as BleManager;
  await assert.rejects(new TagRinger(ble, {} as PinqevaProvisioningClient).connectNearby({
    deviceId, serialNumber: serial, signal: new AbortController().signal,
    onStatus() {}, onError() {}, scanTimeoutMs: 5,
  }), { code: 'RING_NOT_FOUND' });
  assert.equal(stopped, true);
});

test('ring API sends a fresh bearer token and challenge only to the owner endpoint', async () => {
  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (url, init) => {
    called = true;
    assert.equal(url, `https://example.com/v1/devices/${deviceId}/ring/authorize`);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fresh-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { serial_number: serial, tag_challenge_base64url: encodeBase64Url(challenge) });
    return new Response(JSON.stringify({ device_id: deviceId, serial_number: serial, ring_authorization_proof_base64url: encodeBase64Url(proof) }));
  };
  try {
    const result = await new PinqevaProvisioningClient({ baseUrl: 'https://example.com' }, async () => 'fresh-token').authorizeRing({
      deviceId, serialNumber: serial, tagChallengeBase64url: encodeBase64Url(challenge),
    });
    assert.equal(called, true);
    assert.equal(result.device_id, deviceId);
  } finally { globalThis.fetch = previous; }
});

test('ring errors expose safe categories, not backend or native diagnostic text', () => {
  assert.equal(safeRingErrorCode(new ProvisioningApiError('PRIVATE_DETAILS', 403)), 'owner');
  assert.equal(safeRingErrorCode({ errorCode: 101, message: 'private details' }), 'permission');
  assert.equal(safeRingErrorCode({ errorCode: 102 }), 'bluetooth-off');
  assert.equal(safeRingErrorCode({ code: 'RING_NOT_FOUND' }), 'not-found');
  assert.equal(safeRingErrorCode(new Error('secret backend diagnostics')), 'unavailable');
});
