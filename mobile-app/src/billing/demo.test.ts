import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoSubscription } from './demo.ts';

test('demo subscriptions are stable and scoped per tag', () => {
  const card = createDemoSubscription('pinkeva-card');
  const keys = createDemoSubscription('keys');
  const bag = createDemoSubscription('backpack');

  assert.equal(card.deviceId, 'pinkeva-card');
  assert.equal(card.status, 'active');
  assert.equal(card.cancelAtPeriodEnd, false);
  assert.equal(keys.deviceId, 'keys');
  assert.equal(keys.status, 'none');
  assert.equal(bag.deviceId, 'backpack');
  assert.equal(bag.cancelAtPeriodEnd, true);
});
