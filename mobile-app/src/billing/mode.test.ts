import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBillingMode } from './types.ts';

test('billing demo mode requires an explicit development preview', () => {
  assert.equal(resolveBillingMode(false, false, false), 'unavailable');
  assert.equal(resolveBillingMode(false, true, false), 'unavailable');
  assert.equal(resolveBillingMode(true, false, false), 'unavailable');
  assert.equal(resolveBillingMode(false, false, true), 'demo');
  assert.equal(resolveBillingMode(true, true, false), 'live');
});
