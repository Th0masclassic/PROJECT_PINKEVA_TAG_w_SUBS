import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { OwnedTrackerError, fetchOwnedTrackers, parseOwnedTrackerRows } from './cloud.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function activeOwnership(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    device_id: DEVICE_ID,
    started_at: '2026-08-24T10:00:00Z',
    ended_at: null,
    device: {
      id: DEVICE_ID,
      name: 'Wallet',
      status: 'nearby',
      firmware_version: '1.2.3',
    },
    ...overrides,
  };
}

function isInvalidResponse(error: unknown): boolean {
  return error instanceof OwnedTrackerError && error.code === 'invalid-response';
}

test('maps an active owned device to a hosted Tracker with its canonical UUID', () => {
  assert.deepEqual(parseOwnedTrackerRows([activeOwnership()], USER_ID), [
    {
      id: DEVICE_ID,
      source: 'hosted',
      name: 'Wallet',
      kind: 'card',
      status: 'nearby',
      lastSeen: '—',
      place: '—',
      address: '—',
      intervalMs: 1000,
      isLost: false,
      firmwareVersion: '1.2.3',
    },
  ]);
});

test('queries only the authenticated user active ownerships with a safe device projection', async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const ownershipQuery = {
    select(projection: string) {
      calls.push(['select', projection]);
      return this;
    },
    eq(column: string, value: string) {
      calls.push(['eq', column, value]);
      return this;
    },
    is(column: string, value: null) {
      calls.push(['is', column, value]);
      return this;
    },
    order(column: string, options: unknown) {
      calls.push(['order', column, options]);
      return Promise.resolve({ data: [activeOwnership()], error: null, status: 200 });
    },
  };
  const profileQuery = {
    select(projection: string) {
      calls.push(['select', projection]);
      return this;
    },
    eq(column: string, value: string) {
      calls.push(['eq', column, value]);
      return this;
    },
    maybeSingle() {
      calls.push(['maybeSingle']);
      return Promise.resolve({ data: { account_status: 'active' }, error: null, status: 200 });
    },
  };
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return table === 'profiles' ? profileQuery : ownershipQuery;
    },
  } as unknown as SupabaseClient;

  const trackers = await fetchOwnedTrackers(client, USER_ID);

  assert.equal(trackers[0]?.id, DEVICE_ID);
  assert.deepEqual(calls, [
    ['from', 'profiles'],
    ['select', 'account_status'],
    ['eq', 'id', USER_ID],
    ['maybeSingle'],
    ['from', 'ownership'],
    [
      'select',
      'user_id,device_id,started_at,ended_at,device:device!inner(id,serial_number,name,status,firmware_version,last_latitude,last_longitude,last_location_at,last_place)',
    ],
    ['eq', 'user_id', USER_ID],
    ['is', 'ended_at', null],
    ['order', 'started_at', { ascending: true }],
  ]);
});

test('stops before reading tracker data when the account is banned', async () => {
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: { account_status: 'banned' }, error: null, status: 200 });
        },
      };
    },
  } as unknown as SupabaseClient;

  await assert.rejects(
    () => fetchOwnedTrackers(client, USER_ID),
    (error: unknown) => error instanceof OwnedTrackerError && error.code === 'banned',
  );
});

test('uses conservative display defaults for nullable projected fields', () => {
  const tracker = parseOwnedTrackerRows(
    [
      activeOwnership({
        device: {
          id: DEVICE_ID.toUpperCase(),
          name: null,
          status: 'suspended',
          firmware_version: null,
        },
      }),
    ],
    USER_ID,
  )[0];

  assert.equal(tracker?.id, DEVICE_ID);
  assert.equal(tracker?.name, 'Pinkeva Card');
  assert.equal(tracker?.status, 'away');
  assert.equal(tracker?.firmwareVersion, '—');
});

test('rejects cross-user response shapes even if a device is otherwise valid', () => {
  assert.throws(
    () => parseOwnedTrackerRows([activeOwnership({ user_id: OTHER_USER_ID })], USER_ID),
    isInvalidResponse,
  );
});

test('rejects ended ownerships and mismatched nested device identities', () => {
  assert.throws(
    () =>
      parseOwnedTrackerRows(
        [activeOwnership({ ended_at: '2026-08-24T11:00:00Z' })],
        USER_ID,
      ),
    isInvalidResponse,
  );
  assert.throws(
    () =>
      parseOwnedTrackerRows(
        [
          activeOwnership({
            device: {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              name: 'Wallet',
              status: 'away',
              firmware_version: '1.0.0',
            },
          }),
        ],
        USER_ID,
      ),
    isInvalidResponse,
  );
});

test('rejects malformed UUIDs, fields, response containers, and duplicate rows', () => {
  const malformedCases: unknown[] = [
    null,
    {},
    [activeOwnership({ device_id: 'local-preview-id' })],
    [activeOwnership({ started_at: 'not-a-date' })],
    [activeOwnership({ device: [] })],
    [activeOwnership({ device: { id: DEVICE_ID, name: 42, status: null, firmware_version: null } })],
    [activeOwnership(), activeOwnership()],
  ];

  for (const payload of malformedCases) {
    assert.throws(() => parseOwnedTrackerRows(payload, USER_ID), isInvalidResponse);
  }
});
