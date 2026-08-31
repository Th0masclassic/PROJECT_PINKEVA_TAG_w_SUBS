import assert from 'node:assert/strict';
import test from 'node:test';

import { provisioningRequestAction } from './requestState.ts';

test('skips checkout when the provisioning request is covered by the account subscription', () => {
  assert.equal(provisioningRequestAction('paid'), 'claim');
  assert.equal(provisioningRequestAction('claiming'), 'claim');
});

test('requires checkout only while the backend payment gate remains unpaid', () => {
  assert.equal(provisioningRequestAction('pending'), 'payment');
  assert.equal(provisioningRequestAction('creating'), 'payment');
  assert.equal(provisioningRequestAction('open'), 'payment');
});

test('does not attempt a claim for terminal provisioning requests', () => {
  assert.equal(provisioningRequestAction('completed'), 'unavailable');
  assert.equal(provisioningRequestAction('expired'), 'unavailable');
  assert.equal(provisioningRequestAction('failed'), 'unavailable');
});
