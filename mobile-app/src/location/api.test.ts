import assert from 'node:assert/strict';
import test from 'node:test';

import { ProvisioningApiError, type ProvisioningApiConfig } from '../provisioning/api.ts';
import { requestLocationReport } from './api.ts';

const CONFIG: ProvisioningApiConfig = { baseUrl: 'https://api.example.test' };
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('requests one authenticated report and validates the safe location projection', async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(
      JSON.stringify({
        device_id: DEVICE_ID,
        serial_number: 'PKV-140808A9AF68',
        report_status: 'updated',
        latitude: 38.7223,
        longitude: -9.1393,
        last_location_at: '2026-08-24T12:00:00Z',
        last_place: '38.72230, -9.13930',
        confidence: 3,
        status_code: 1,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const report = await requestLocationReport(CONFIG, async () => 'access-token', DEVICE_ID);
    assert.equal(report.device_id, DEVICE_ID);
    assert.equal(report.latitude, 38.7223);
    assert.equal(request?.url, `${CONFIG.baseUrl}/v1/devices/${DEVICE_ID}/location/report`);
    assert.equal(request?.init?.method, 'POST');
    assert.equal(
      (request?.init?.headers as Record<string, string>).Authorization,
      'Bearer access-token',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not expose an upstream error body to the app', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'LOCATION_UNAVAILABLE',
          message: 'postgres private key ciphertext must not be shown',
        },
      }),
      { status: 503, headers: { 'X-Request-ID': 'request-1' } },
    )) as typeof fetch;

  try {
    await assert.rejects(
      requestLocationReport(CONFIG, async () => 'access-token', DEVICE_ID),
      (error: unknown) =>
        error instanceof ProvisioningApiError &&
        error.code === 'LOCATION_UNAVAILABLE' &&
        !error.message.includes('private key'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
