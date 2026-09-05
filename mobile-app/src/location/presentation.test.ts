import assert from 'node:assert/strict';
import test from 'node:test';

import type { Translate } from '../i18n.tsx';
import type { Tracker } from '../model.ts';
import type { DeviceSafeZone } from '../premium/api.ts';
import {
  createTrackerLocationPresentation,
  formatDistanceAway,
  isCoordinateLikeLabel,
} from './presentation.ts';

const tracker: Tracker = {
  id: 'tracker', source: 'hosted', name: 'Wallet', kind: 'card', status: 'away',
  lastSeen: '2 min ago', lastLocationAt: '2026-09-04T12:00:00Z',
  place: '38.72230, -9.13930', address: '38.72230, -9.13930',
  intervalMs: 1000, firmwareVersion: '1.0.0', latitude: 38.7223, longitude: -9.1393,
};

const t = ((key: string, params: Record<string, string | number> = {}) => {
  if (key === 'time.justNow') return 'Just now';
  if (key === 'time.minutesAgo') return `${params.count} min ago`;
  if (key === 'time.hoursAgo') return `${params.count} h ago`;
  return key;
}) as Translate;

test('formats distance at the metre/kilometre boundary with locale decimals', () => {
  assert.equal(formatDistanceAway(120, 'en'), '120 m away');
  assert.equal(formatDistanceAway(1_400, 'pt'), '1,4 km de distância');
});

test('never presents a coordinate-shaped backend place', () => {
  assert.equal(isCoordinateLikeLabel(tracker.place), true);
  const result = createTrackerLocationPresentation({
    tracker, language: 'en', t,
    now: Date.parse('2026-09-04T12:02:00Z'),
  });
  assert.equal(result.primary, 'Location available on map');
  assert.equal(result.primary.includes('38.7223'), false);
});

test('promotes only a currently evaluated enabled Safe Zone', () => {
  const zone: DeviceSafeZone = {
    id: 'zone', deviceId: tracker.id, name: 'Home', latitude: 38.72, longitude: -9.14,
    radiusMeters: 75, enabled: true, lastTrackerInside: true,
    lastEvaluatedAt: tracker.lastLocationAt!, createdAt: tracker.lastLocationAt!, updatedAt: tracker.lastLocationAt!,
  };
  const result = createTrackerLocationPresentation({
    tracker, language: 'en', t, safeZones: [zone],
  });
  assert.equal(result.primary, 'Inside Home');
  const stale = createTrackerLocationPresentation({
    tracker: { ...tracker, lastLocationAt: '2026-09-04T13:00:00Z' },
    language: 'en', t, safeZones: [zone],
  });
  assert.notEqual(stale.primary, 'Inside Home');
  const missingTrackerTime = createTrackerLocationPresentation({
    tracker: { ...tracker, lastLocationAt: undefined },
    language: 'en', t, safeZones: [zone],
  });
  assert.notEqual(missingTrackerTime.primary, 'Inside Home');
});
