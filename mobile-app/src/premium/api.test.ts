import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProvisioningApiConfig } from '../provisioning/api.ts';
import {
  createSafeZone,
  createRecoveryShare,
  createReplacementClaim,
  deleteLocationHistory,
  deleteSafeZone,
  getCompanionStatus,
  getPremiumFeatures,
  getPremiumOverview,
  getProtectionProfile,
  getRecoveryReport,
  getReplacementEligibility,
  listRecoveryShares,
  listReplacementClaims,
  listSafeZones,
  PremiumApiError,
  recoveryShareUrl,
  reportCompanionObservation,
  resetCompanion,
  revokeRecoveryShare,
  updateProtectionProfile,
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
    const update = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      ...safeZonePayload,
      ...(typeof update.radius_meters === 'number' ? { radius_meters: update.radius_meters } : {}),
      ...(typeof update.enabled === 'boolean' ? { enabled: update.enabled } : {}),
    }), {
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
    const paused = await updateSafeZone(
      CONFIG,
      async () => 'token',
      DEVICE_ID,
      SAFE_ZONE_ID,
      { enabled: false },
    );
    await deleteSafeZone(CONFIG, async () => 'token', DEVICE_ID, SAFE_ZONE_ID);
    assert.equal(updated.radiusMeters, 125);
    assert.equal(paused.enabled, false);
    assert.deepEqual(calls.map((call) => [call.url, call.init?.method]), [
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones/${SAFE_ZONE_ID}`, 'PATCH'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones/${SAFE_ZONE_ID}`, 'PATCH'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/safe-zones/${SAFE_ZONE_ID}`, 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { radius_meters: 125 });
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { enabled: false });
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

const protectionPayload = {
  device_id: DEVICE_ID,
  separation_alerts: true,
  separation_threshold_meters: 500,
  vehicle_mode: false,
  movement_alerts: true,
  movement_threshold_meters: 750,
  updated_at: '2026-08-31T10:00:00Z',
};

const companionPayload = {
  device_id: DEVICE_ID,
  subscription_active: true,
  configured: true,
  installation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  platform: 'ios',
  observation_accepted: true,
  last_observation_at: '2026-08-31T10:00:00Z',
  phone_accuracy_meters: 12.5,
  tag_proximity: 'unknown',
  tag_observed_at: null,
  tag_rssi_dbm: null,
};

const sharePayload = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  device_id: DEVICE_ID,
  label: 'Recovery contact',
  access_level: 'history',
  expires_at: '2026-09-03T10:00:00Z',
  revoked_at: null,
  last_accessed_at: null,
  created_at: '2026-08-31T10:00:00Z',
};

const eligibilityPayload = {
  device_id: DEVICE_ID,
  eligible: true,
  reason: 'eligible',
  minimum_plan_months: 6,
  current_plan_months: 12,
  benefit_period_start: '2026-08-01T00:00:00Z',
  benefit_period_end: '2027-08-01T00:00:00Z',
  existing_claim_id: null,
  existing_claim_status: null,
};

const claimPayload = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  device_id: DEVICE_ID,
  subscription_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  reason: 'lost',
  incident_at: '2026-08-31T09:00:00Z',
  status: 'submitted',
  notes: 'Lost during commute',
  benefit_period_start: '2026-08-01T00:00:00Z',
  benefit_period_end: '2027-08-01T00:00:00Z',
  replacement_price_minor: 0,
  replacement_device_id: null,
  replacement_serial_number: null,
  provisioning_request_id: null,
  submitted_at: '2026-08-31T10:00:00Z',
  reviewed_at: null,
  fulfilled_at: null,
};

test('premium protection and recovery clients use only documented backend routes', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const shareToken = 'A'.repeat(43);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown;
    if (url.endsWith('/protection')) body = protectionPayload;
    else if (url.endsWith('/companion') && init?.method === 'DELETE') body = {
      device_id: DEVICE_ID,
      status: 'removed',
    };
    else if (url.endsWith('/companion/observations') || url.endsWith('/companion')) body = companionPayload;
    else if (url.endsWith('/recovery-report')) body = {
      device_id: DEVICE_ID,
      tracker_name: 'Keys',
      serial_number: 'PKV-AABBCCDDEEFF',
      generated_at: '2026-08-31T10:00:00Z',
      protection_status: 'active',
      subscription_period_end: '2027-08-01T00:00:00Z',
      last_location: { latitude: 38.72, longitude: -9.13, recorded_at: '2026-08-31T09:00:00Z' },
      location_count_30d: 12,
      safe_zone_count: 2,
      active_share_count: 1,
      recent_alert_count_30d: 3,
      companion_status: 'ready',
      replacement_eligible: true,
      replacement_claim_status: null,
    };
    else if (url.endsWith('/recovery-shares') && init?.method === 'POST') body = {
      ...sharePayload,
      share_token: shareToken,
      share_path: `/recovery#token=${shareToken}`,
    };
    else if (url.endsWith(`/recovery-shares/${sharePayload.id}`) && init?.method === 'DELETE') body = {
      ...sharePayload,
      revoked_at: '2026-08-31T11:00:00Z',
    };
    else if (url.endsWith('/recovery-shares')) body = { shares: [sharePayload] };
    else if (url.endsWith('/replacement-eligibility')) body = eligibilityPayload;
    else if (url.endsWith('/replacement-claims') && init?.method === 'POST') body = claimPayload;
    else if (url.endsWith('/replacement-claims')) body = { claims: [claimPayload] };
    else if (url.endsWith('/location/history')) body = { device_id: DEVICE_ID, deleted_reports: 12 };
    else throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200 });
  }) as typeof fetch;

  try {
    await getProtectionProfile(CONFIG, async () => 'token', DEVICE_ID);
    await updateProtectionProfile(CONFIG, async () => 'token', DEVICE_ID, {
      separationAlerts: false,
      separationThresholdMeters: 1_000,
      vehicleMode: true,
      movementAlerts: true,
      movementThresholdMeters: 2_000,
    });
    await getCompanionStatus(CONFIG, async () => 'token', DEVICE_ID);
    await reportCompanionObservation(CONFIG, async () => 'token', DEVICE_ID, {
      installationId: companionPayload.installation_id,
      platform: 'ios',
      phoneLatitude: 38.72,
      phoneLongitude: -9.13,
      phoneAccuracyMeters: 12.5,
      sampledAt: '2026-08-31T10:00:00Z',
      tagProximity: 'unknown',
    });
    await resetCompanion(CONFIG, async () => 'token', DEVICE_ID);
    const report = await getRecoveryReport(CONFIG, async () => 'token', DEVICE_ID);
    await listRecoveryShares(CONFIG, async () => 'token', DEVICE_ID);
    const share = await createRecoveryShare(CONFIG, async () => 'token', DEVICE_ID, {
      label: 'Recovery contact',
      accessLevel: 'history',
      expiresInHours: 72,
    });
    await revokeRecoveryShare(CONFIG, async () => 'token', DEVICE_ID, sharePayload.id);
    await getReplacementEligibility(CONFIG, async () => 'token', DEVICE_ID);
    await listReplacementClaims(CONFIG, async () => 'token', DEVICE_ID);
    await createReplacementClaim(CONFIG, async () => 'token', DEVICE_ID, {
      reason: 'lost',
      incidentAt: '2026-08-31T09:00:00Z',
      notes: 'Lost during commute',
    });
    const deleted = await deleteLocationHistory(CONFIG, async () => 'token', DEVICE_ID);

    assert.equal(report.locationCount30d, 12);
    assert.equal(recoveryShareUrl(CONFIG, share), `https://api.example.test/recovery#token=${shareToken}`);
    assert.equal(deleted.deletedReports, 12);
    assert.deepEqual(calls.map((call) => [call.url, call.init?.method ?? 'GET']), [
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/protection`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/protection`, 'PATCH'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/companion`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/companion/observations`, 'POST'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/companion`, 'DELETE'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/recovery-report`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/recovery-shares`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/recovery-shares`, 'POST'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/recovery-shares/${sharePayload.id}`, 'DELETE'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/replacement-eligibility`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/replacement-claims`, 'GET'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/replacement-claims`, 'POST'],
      [`${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/location/history`, 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      separation_alerts: false,
      separation_threshold_meters: 1_000,
      vehicle_mode: true,
      movement_alerts: true,
      movement_threshold_meters: 2_000,
    });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
      installation_id: companionPayload.installation_id,
      platform: 'ios',
      phone_latitude: 38.72,
      phone_longitude: -9.13,
      phone_accuracy_meters: 12.5,
      sampled_at: '2026-08-31T10:00:00Z',
      tag_proximity: 'unknown',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recovery links reject a path that does not bind the returned capability', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ...sharePayload,
    share_token: 'A'.repeat(43),
    share_path: `/recovery#token=${'B'.repeat(43)}`,
  }), { status: 201 })) as typeof fetch;
  try {
    await assert.rejects(
      () => createRecoveryShare(CONFIG, async () => 'token', DEVICE_ID, {
        label: 'Recovery contact', accessLevel: 'latest', expiresInHours: 24,
      }),
      (error: unknown) => error instanceof PremiumApiError && error.code === 'INVALID_RESPONSE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
