import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_TRACKER,
  DEMO_TRACKERS,
  addCanonicalCard,
  applyTrackerIconOverrides,
  chooseMainTrackerId,
  formatInterval,
  nextOperationPhase,
  nextPairingPhase,
  parseTrackerPreferences,
  reconcileTrackerPreferences,
  recordTrackerOpened,
  removeTracker,
  resolveTrackerIcon,
  selectRecentTrackers,
  selectBillingDeviceIds,
  setTrackerIconOverride,
  updateTracker,
} from './model.ts';

test('pairing moves through the complete static demo flow', () => {
  assert.equal(nextPairingPhase('searching'), 'connecting');
  assert.equal(nextPairingPhase('connecting'), 'success');
  assert.equal(nextPairingPhase('installing'), 'success');
  assert.equal(nextPairingPhase('success'), 'idle');
});

test('software updates install after connecting while other operations finish immediately', () => {
  assert.equal(nextOperationPhase('searching', 'firmware'), 'connecting');
  assert.equal(nextOperationPhase('connecting', 'firmware'), 'installing');
  assert.equal(nextOperationPhase('installing', 'firmware'), 'success');
  assert.equal(nextOperationPhase('connecting', 'interval'), 'success');
  assert.equal(nextOperationPhase('connecting', 'add'), 'success');
});

test('demo trackers expose broadcast presence, never a persistent connected state', () => {
  assert.deepEqual(new Set(DEMO_TRACKERS.map((tracker) => tracker.status)), new Set(['nearby', 'away']));
});

test('every paired card gets a unique identity while sharing the canonical artwork kind', () => {
  const once = addCanonicalCard([]);
  const twice = addCanonicalCard(once);
  const threeTimes = addCanonicalCard(twice);
  const afterMiddleRemoval = addCanonicalCard(removeTracker(threeTimes, 'pinkeva-card-2'));
  assert.equal(once.length, 1);
  assert.equal(twice.length, 2);
  assert.notEqual(twice[0]?.id, twice[1]?.id);
  assert.equal(twice[0]?.kind, 'card');
  assert.equal(twice[1]?.kind, 'card');
  assert.equal(once[0]?.source, 'local-preview');
  assert.equal(new Set(afterMiddleRemoval.map((tracker) => tracker.id)).size, afterMiddleRemoval.length);
  assert.equal(afterMiddleRemoval[0]?.id, 'pinkeva-card-2');
});

test('live billing receives hosted UUIDs only and local pairing previews are never billable', () => {
  const hosted = {
    ...CARD_TRACKER,
    id: '11111111-1111-4111-8111-111111111111',
    source: 'hosted' as const,
  };
  const localPreview = addCanonicalCard([])[0];

  assert.deepEqual(selectBillingDeviceIds([hosted, localPreview!], false), [hosted.id]);
  assert.deepEqual(selectBillingDeviceIds([DEMO_TRACKERS[0]!, hosted, localPreview!], true), [
    DEMO_TRACKERS[0]!.id,
    hosted.id,
  ]);
});

test('trackers can be updated and removed without mutating the source', () => {
  const source = [CARD_TRACKER];
  const updated = updateTracker(source, CARD_TRACKER.id, { intervalMs: 5000 });
  assert.equal(source[0]?.intervalMs, 1000);
  assert.equal(updated[0]?.intervalMs, 5000);
  assert.deepEqual(removeTracker(updated, CARD_TRACKER.id), []);
});

test('interval labels are human friendly', () => {
  assert.equal(formatInterval(5000), '5s');
  assert.equal(formatInterval(750), '750 ms');
});

test('recent trackers are unique, newest first, capped, and filtered when removed', () => {
  const recent = recordTrackerOpened(
    recordTrackerOpened(recordTrackerOpened([], 'pinkeva-card'), 'keys'),
    'pinkeva-card',
  );
  assert.deepEqual(recent, ['pinkeva-card', 'keys']);
  assert.deepEqual(
    selectRecentTrackers(DEMO_TRACKERS, ['missing', 'keys', 'keys', 'backpack']).map(
      (tracker) => tracker.id,
    ),
    ['keys', 'backpack'],
  );
});

test('main tracker uses a valid preference and chooses a deterministic fallback once', () => {
  assert.equal(chooseMainTrackerId(DEMO_TRACKERS, 'keys', () => 0.99), 'keys');
  assert.equal(chooseMainTrackerId(DEMO_TRACKERS, 'missing', () => 0), 'pinkeva-card');
  assert.equal(chooseMainTrackerId(DEMO_TRACKERS, null, () => 0.999999), 'backpack');
  assert.equal(chooseMainTrackerId([], 'keys', () => 0.5), null);

  const reconciled = reconcileTrackerPreferences(
    DEMO_TRACKERS,
    { version: 1, recentTrackerIds: ['missing', 'keys'], mainTrackerId: 'missing', iconOverrides: {} },
    () => 0.5,
  );
  assert.equal(reconciled.mainTrackerId, 'keys');
  assert.deepEqual(reconciled.recentTrackerIds, ['keys']);
  assert.equal(reconcileTrackerPreferences(DEMO_TRACKERS, reconciled, () => 0).mainTrackerId, 'keys');
});

test('tracker icon overrides default to card and selecting card removes local data', () => {
  const keys = setTrackerIconOverride({}, 'keys', 'keys');
  const car = setTrackerIconOverride(keys, 'backpack', 'car');
  assert.equal(resolveTrackerIcon('pinkeva-card', car), 'card');
  assert.equal(resolveTrackerIcon('keys', car), 'keys');
  assert.equal(resolveTrackerIcon('backpack', car), 'car');
  assert.equal(applyTrackerIconOverrides(DEMO_TRACKERS, car)[2]?.kind, 'car');
  assert.deepEqual(setTrackerIconOverride(keys, 'keys', 'card'), {});
  assert.equal(keys.keys, 'keys');
});

test('stored tracker preferences are sanitized safely', () => {
  assert.deepEqual(parseTrackerPreferences(null), {
    version: 1,
    recentTrackerIds: [],
    mainTrackerId: null,
    iconOverrides: {},
  });
  assert.deepEqual(
    parseTrackerPreferences({
      version: 1,
      recentTrackerIds: ['keys', 5, 'backpack'],
      mainTrackerId: 'keys',
      iconOverrides: { keys: 'keys', bad: 'plane', card: 'card' },
    }),
    {
      version: 1,
      recentTrackerIds: ['keys', 'backpack'],
      mainTrackerId: 'keys',
      iconOverrides: { keys: 'keys' },
    },
  );
});
