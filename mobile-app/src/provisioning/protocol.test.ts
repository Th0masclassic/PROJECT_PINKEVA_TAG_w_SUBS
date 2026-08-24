import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_BONDING_SETUP_CAPABILITY,
  ProvisioningClientError,
  bytesEqual,
  decodeDeviceIdentifier,
  decodeTagKeyFingerprint,
  normalizeAdvertisedSerial,
  parseProtocolInformation,
  provisioningStatusIsReady,
} from './protocol.ts';

test('accepts only canonical advertised PKV serials', () => {
  assert.equal(normalizeAdvertisedSerial('pkv-aabbccddeeff'), 'PKV-AABBCCDDEEFF');
  assert.equal(normalizeAdvertisedSerial('PKV-123'), null);
  assert.equal(normalizeAdvertisedSerial('OTHER-AABBCCDDEEFF'), null);
  assert.equal(normalizeAdvertisedSerial(null), null);
});

test('parses protocol v1 capability bytes and the GATT serial', () => {
  assert.deepEqual(parseProtocolInformation(Uint8Array.of(1, 3, 1, 4, 0x30, 0)), {
    protocolMajor: 1,
    protocolMinor: 3,
    firmwareMajor: 1,
    firmwareMinor: 4,
    capabilities: 0x30,
  });
  assert.equal(0x30 & NON_BONDING_SETUP_CAPABILITY, NON_BONDING_SETUP_CAPABILITY);
  assert.equal(
    decodeDeviceIdentifier(Uint8Array.from(Buffer.from('PKV-AABBCCDDEEFF', 'ascii'))),
    'PKV-AABBCCDDEEFF',
  );
  assert.throws(
    () => decodeDeviceIdentifier(Uint8Array.from(Buffer.from('PKV-123', 'ascii'))),
    ProvisioningClientError,
  );
});

test('treats an all-zero fingerprint as unprovisioned', () => {
  assert.equal(decodeTagKeyFingerprint(new Uint8Array(32)), null);
  const fingerprint = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  assert.equal(decodeTagKeyFingerprint(fingerprint), fingerprint);
  assert.equal(bytesEqual(fingerprint, fingerprint.slice()), true);
  assert.equal(bytesEqual(fingerprint, new Uint8Array(32)), false);
});

test('accepts only the explicit ready-success status', () => {
  assert.equal(provisioningStatusIsReady(Uint8Array.of(0x04, 0x00)), true);
  assert.equal(provisioningStatusIsReady(Uint8Array.of(0x03, 0x00)), false);
  assert.throws(
    () => provisioningStatusIsReady(Uint8Array.of(0x7f, 0x05)),
    ProvisioningClientError,
  );
});
