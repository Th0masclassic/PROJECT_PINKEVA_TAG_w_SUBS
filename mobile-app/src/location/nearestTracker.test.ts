import assert from 'node:assert/strict';
import test from 'node:test';

import type { Tracker } from '../model.ts';
import { distanceInMeters, selectClosestLocatedTracker } from './nearestTracker.ts';

function tracker(id: string, latitude?: number, longitude?: number): Tracker {
  return {
    id,
    source: 'hosted',
    name: id,
    kind: 'card',
    status: 'away',
    lastSeen: '—',
    place: '—',
    address: '—',
    intervalMs: 1000,
    firmwareVersion: '—',
    ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}),
  };
}

test('selects the located tag closest to the user', () => {
  const lisbon = tracker('lisbon', 38.7223, -9.1393);
  const porto = tracker('porto', 41.1579, -8.6291);

  assert.equal(
    selectClosestLocatedTracker(
      [porto, lisbon],
      { latitude: 38.7167, longitude: -9.1333 },
    )?.id,
    'lisbon',
  );
});

test('falls back to the preferred located tag while user location is unavailable', () => {
  const first = tracker('first', 38.7, -9.1);
  const preferred = tracker('preferred', 40.6, -8.6);

  assert.equal(
    selectClosestLocatedTracker([first, preferred], undefined, preferred.id)?.id,
    preferred.id,
  );
  assert.equal(selectClosestLocatedTracker([tracker('missing')], undefined), undefined);
});

test('calculates a zero distance for the same coordinate', () => {
  const coordinate = { latitude: 38.7223, longitude: -9.1393 };
  assert.equal(distanceInMeters(coordinate, coordinate), 0);
});

test('calculates a realistic short distance in meters', () => {
  const origin = { latitude: 38.7223, longitude: -9.1393 };
  const roughlyOneHundredMetersNorth = {
    latitude: origin.latitude + (100 / 6_371_000) * (180 / Math.PI),
    longitude: origin.longitude,
  };

  assert.ok(Math.abs(distanceInMeters(origin, roughlyOneHundredMetersNorth) - 100) < 0.1);
});
