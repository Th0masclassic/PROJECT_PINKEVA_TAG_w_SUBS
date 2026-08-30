import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoSubscription } from './demo.ts';

test('one demo account subscription is projected onto every owned tag', () => {
  const card = createDemoSubscription('pinkeva-card');
  const keys = createDemoSubscription('keys');
  const bag = createDemoSubscription('backpack');

  assert.equal(card.deviceId, 'pinkeva-card');
  assert.equal(card.status, 'active');
  assert.equal(card.cancelAtPeriodEnd, false);
  assert.equal(keys.deviceId, 'keys');
  assert.equal(keys.status, 'active');
  assert.equal(keys.planCode, card.planCode);
  assert.equal(bag.deviceId, 'backpack');
  assert.equal(bag.status, 'active');
  assert.equal(bag.planCode, card.planCode);
  assert.equal(bag.cancelAtPeriodEnd, false);
});
