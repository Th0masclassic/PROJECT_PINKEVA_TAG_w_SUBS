import assert from 'node:assert/strict';
import test from 'node:test';

import { canUseSafeZones } from './entitlements.ts';

test('Safe Zones require both an active subscription and backend entitlement', () => {
  assert.equal(canUseSafeZones({ subscriptionActive: true, safeZones: true }), true);
  assert.equal(canUseSafeZones({ subscriptionActive: false, safeZones: true }), false);
  assert.equal(canUseSafeZones({ subscriptionActive: true, safeZones: false }), false);
  assert.equal(canUseSafeZones(undefined), false);
});
