import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_BONDING_SETUP_CAPABILITY,
  UTC_TIME_SYNC_CAPABILITY,
  ProvisioningClientError,
  bytesEqual,
  decodeDeviceIdentifier,
  decodeTagKeyFingerprint,
  encodeUtcUnixSeconds,
  normalizeAdvertisedSerial,
  parseFirmwareStatus,
  parseFirmwareVersion,
  parseProtocolInformation,
  provisioningStatusIsReady,
} from './protocol.ts';

test('accepts only canonical advertised PKV serials', () => {
  assert.equal(normalizeAdvertisedSerial('pkv-aabbccddeeff'), 'PKV-AABBCCDDEEFF');
  assert.equal(normalizeAdvertisedSerial('PKV-123'), null);
  assert.equal(normalizeAdvertisedSerial('OTHER-AABBCCDDEEFF'), null);
  assert.equal(normalizeAdvertisedSerial(null), null);
});

test('parses exact OTA firmware versions and transfer status', () => {
  assert.equal(parseFirmwareVersion(Uint8Array.of(0, 3, 1)), '0.3.1');
  assert.deepEqual(parseFirmwareStatus(Uint8Array.of(2, 0, 0, 1, 2, 3)), {
    state: 2,
    result: 0,
    receivedBytes: 0x010203,
  });
  assert.throws(() => parseFirmwareVersion(Uint8Array.of(1, 2)), ProvisioningClientError);
});

test('parses protocol v1 capability bytes and the GATT serial', () => {
  assert.deepEqual(parseProtocolInformation(Uint8Array.of(1, 4, 1, 4, 0x70, 0)), {
    protocolMajor: 1,
    protocolMinor: 4,
    firmwareMajor: 1,
    firmwareMinor: 4,
    capabilities: 0x70,
  });
  assert.equal(0x70 & NON_BONDING_SETUP_CAPABILITY, NON_BONDING_SETUP_CAPABILITY);
  assert.equal(0x70 & UTC_TIME_SYNC_CAPABILITY, UTC_TIME_SYNC_CAPABILITY);
  assert.equal(
    decodeDeviceIdentifier(Uint8Array.from(Buffer.from('PKV-AABBCCDDEEFF', 'ascii'))),
    'PKV-AABBCCDDEEFF',
  );
  assert.throws(
    () => decodeDeviceIdentifier(Uint8Array.from(Buffer.from('PKV-123', 'ascii'))),
    ProvisioningClientError,
  );
});

test('encodes the phone clock as unsigned big-endian Unix UTC seconds', () => {
  assert.deepEqual(
    encodeUtcUnixSeconds(new Date('2026-08-25T20:00:00Z')),
    Uint8Array.of(0, 0, 0, 0, 0x6a, 0x8d, 0xf4, 0x40),
  );
  assert.throws(() => encodeUtcUnixSeconds(new Date('invalid')), ProvisioningClientError);
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
