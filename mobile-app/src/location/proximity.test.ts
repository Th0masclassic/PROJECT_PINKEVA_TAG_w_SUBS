import assert from 'node:assert/strict';
import test from 'node:test';

import { trackerDistanceThresholdMeters, trackerProximityStatus } from './proximity.ts';

const ORIGIN = { latitude: 38.7223, longitude: -9.1393 };

function northByMeters(meters: number) {
  return {
    latitude: ORIGIN.latitude + (meters / 6_371_000) * (180 / Math.PI),
    longitude: ORIGIN.longitude,
  };
}

function tracker(kind: 'card' | 'keys' | 'backpack' | 'car', meters: number) {
  const coordinate = northByMeters(meters);
  return { kind, latitude: coordinate.latitude, longitude: coordinate.longitude } as const;
}

test('uses a 100 m threshold for Card and Keys', () => {
  assert.equal(trackerDistanceThresholdMeters('card'), 100);
  assert.equal(trackerDistanceThresholdMeters('keys'), 100);
  assert.equal(trackerProximityStatus(tracker('card', 99), ORIGIN), 'nearby');
  assert.equal(trackerProximityStatus(tracker('card', 101), ORIGIN), 'away');
  assert.equal(trackerProximityStatus(tracker('keys', 101), ORIGIN), 'away');
});

test('uses a 1 km threshold for Car', () => {
  assert.equal(trackerDistanceThresholdMeters('car'), 1_000);
  assert.equal(trackerProximityStatus(tracker('car', 999), ORIGIN), 'nearby');
  assert.equal(trackerProximityStatus(tracker('car', 1_001), ORIGIN), 'away');
});

test('returns no derived status when either coordinate is unavailable', () => {
  assert.equal(
    trackerProximityStatus({ kind: 'card', latitude: 38.7 }, ORIGIN),
    undefined,
  );
  assert.equal(
    trackerProximityStatus({ kind: 'card', latitude: 38.7, longitude: -9.1 }, undefined),
    undefined,
  );
});
