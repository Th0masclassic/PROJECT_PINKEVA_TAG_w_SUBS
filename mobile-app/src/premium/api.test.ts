import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProvisioningApiConfig } from '../provisioning/api.ts';
import {
  createSafeZone,
  deleteSafeZone,
  getPremiumFeatures,
  getPremiumOverview,
  listSafeZones,
  PremiumApiError,
  updateSafeZone,
} from './api.ts';

const CONFIG: ProvisioningApiConfig = { baseUrl: 'https://api.example.test' };
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAFE_ZONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const featurePayload = {
  device_id: DEVICE_ID,
  subscription_active: true,
  tier: 'premium',
  cloud_location_reports: true,
  location_history_days: 30,
  smart_alerts: true,
  safe_zones: true,
  companion_separation_alerts: true,
  trusted_sharing: true,
  recovery_report: true,
  vehicle_mode: true,
  replacement_benefit: false,
};

const safeZonePayload = {
  id: SAFE_ZONE_ID,
  device_id: DEVICE_ID,
  name: 'House',
  latitude: 38.7223,
  longitude: -9.1393,
  radius_meters: 50,
  enabled: true,
  last_tracker_inside: false,
  last_evaluated_at: '2026-08-29T10:00:00Z',
  created_at: '2026-08-28T10:00:00Z',
  updated_at: '2026-08-29T10:00:00Z',
};

test('loads phone-aware premium features with bearer authentication', async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(featurePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const features = await getPremiumFeatures(CONFIG, async () => 'access-token', DEVICE_ID);
    assert.equal(features.subscriptionActive, true);
    assert.equal(features.locationHistoryDays, 30);
    assert.equal(features.companionSeparationAlerts, true);
    assert.equal(
      request?.url,
      `${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/premium/features`,
    );
    assert.equal(request?.init?.method, 'GET');
    assert.equal(
      (request?.init?.headers as Record<string, string>).Authorization,
      'Bearer access-token',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loads the premium tracker overview contract', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        device_id: DEVICE_ID,
        tracker_name: 'Keys',
        subscription_active: true,
        location_status: 'current',
        last_location_at: '2026-08-29T10:00:00Z',
        firmware_version: '1.2.0',
        separation_alerts: true,
        vehicle_mode: false,
        movement_alerts: true,
        safe_zone_count: 1,
        active_share_count: 0,
        companion_status: 'ready',
        replacement_eligible: true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

  try {
    const overview = await getPremiumOverview(CONFIG, async () => 'token', DEVICE_ID);
    assert.equal(overview.locationStatus, 'current');
    assert.equal(overview.companionStatus, 'ready');
    assert.equal(overview.replacementEligible, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lists safe zones and preserves the last evaluation state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ safe_zones: [safeZonePayload] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  try {
    const zones = await listSafeZones(CONFIG, async () => 'token', DEVICE_ID);
    assert.equal(zones.length, 1);
    assert.equal(zones[0]?.lastTrackerInside, false);
    assert.equal(zones[0]?.lastEvaluatedAt, '2026-08-29T10:00:00Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creates a safe zone with only the supported fields', async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(safeZonePayload), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await createSafeZone(CONFIG, async () => 'token', DEVICE_ID, {
      name: '  House  ',
      latitude: 38.7223,
      longitude: -9.1393,
      radiusMeters: 50,
    });
    assert.equal(request?.url, `${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones`);
    assert.equal(request?.init?.method, 'POST');
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      name: 'House',
      latitude: 38.7223,
      longitude: -9.1393,
      radius_meters: 50,
    });
    assert.equal('notify_on_enter' in body, false);
    assert.equal('notify_on_exit' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('updates and deletes the exact safe-zone resource', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ...safeZonePayload, radius_meters: 125 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const updated = await updateSafeZone(
      CONFIG,
      async () => 'token',
      DEVICE_ID,
      SAFE_ZONE_ID,
      { radiusMeters: 125 },
    );
    await deleteSafeZone(CONFIG, async () => 'token', DEVICE_ID, SAFE_ZONE_ID);
    assert.equal(updated.radiusMeters, 125);
    assert.deepEqual(calls.map((call) => [call.url, call.init?.method]), [
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones/${SAFE_ZONE_ID}`, 'PATCH'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones/${SAFE_ZONE_ID}`, 'DELETE'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('enforces the 50 metre minimum radius before a request is sent', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;

  try {
    await assert.rejects(
      createSafeZone(CONFIG, async () => 'token', DEVICE_ID, {
        name: 'House',
        latitude: 38.7223,
        longitude: -9.1393,
        radiusMeters: 49,
      }),
      (error: unknown) =>
        error instanceof PremiumApiError && error.code === 'INVALID_SAFE_ZONE_RADIUS',
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not expose backend error details to the app', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'SAFE_ZONE_LIMIT_REACHED',
          message: 'private database details',
          request_id: 'request-1',
        },
      }),
      { status: 409 },
    )) as typeof fetch;

  try {
    await assert.rejects(
      createSafeZone(CONFIG, async () => 'token', DEVICE_ID, {
        name: 'House',
        latitude: 38.7223,
        longitude: -9.1393,
        radiusMeters: 50,
      }),
      (error: unknown) =>
        error instanceof PremiumApiError &&
        error.code === 'SAFE_ZONE_LIMIT_REACHED' &&
        !error.message.includes('database'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
