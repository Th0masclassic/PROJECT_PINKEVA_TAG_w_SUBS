import assert from 'node:assert/strict';
import test from 'node:test';

import { ProvisioningApiError } from './api.ts';
import { ProvisioningClientError } from './protocol.ts';
import { TagRadioError } from './radio.types.ts';
import { safeTagSetupErrorCode, tagSetupErrorTranslationKey } from './setup.ts';

test('maps radio and backend failures to stable safe categories', () => {
  assert.equal(
    safeTagSetupErrorCode(new TagRadioError('BLUETOOTH_PERMISSION_DENIED')),
    'bluetooth-permission',
  );
  assert.equal(
    safeTagSetupErrorCode(new ProvisioningApiError('DEVICE_UNAVAILABLE', 409, 'request-id')),
    'tag-unavailable',
  );
  assert.equal(
    safeTagSetupErrorCode(new ProvisioningApiError('RECOVERY_REQUIRED', 409)),
    'recovery-required',
  );
  assert.equal(
    safeTagSetupErrorCode(new ProvisioningClientError('UNSUPPORTED_PROTOCOL', 'secret detail')),
    'incompatible',
  );
});

test('does not expose unknown upstream details to the interface', () => {
  const code = safeTagSetupErrorCode(new Error('database password and stack trace'));
  assert.equal(code, 'connection');
  assert.equal(tagSetupErrorTranslationKey(code), 'pairing.errorConnection');
});
