import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PinqevaProvisioningClient,
  ProvisioningApiError,
  parseProvisioningApiConfig,
} from './api.ts';

test('accepts HTTPS and loopback development API URLs only', () => {
  assert.deepEqual(parseProvisioningApiConfig('https://api.pinkeva.com/'), {
    baseUrl: 'https://api.pinkeva.com',
  });
  assert.deepEqual(parseProvisioningApiConfig('http://127.0.0.1:8080'), {
    baseUrl: 'http://127.0.0.1:8080',
  });
  assert.equal(parseProvisioningApiConfig('http://192.168.1.10:8080'), null);
  assert.equal(parseProvisioningApiConfig('https://user:pass@example.com'), null);
  assert.equal(parseProvisioningApiConfig('https://api.pinkeva.com?token=no'), null);
});

test('sends the authenticated two-phase claim contract', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/v1/devices/claim')) {
      return new Response(
        JSON.stringify({
          session_id: '11111111-1111-4111-8111-111111111111',
          serial_number: 'PKV-AABBCCDDEEFF',
          protocol_version: 1,
          tag_action: 'write_key',
          advertisement_key_base64url: 'key',
          advertisement_key_sha256_base64url: 'fingerprint',
          google_advertisement_key_base64url: 'google-key',
          google_advertisement_key_sha256_base64url: 'google-fingerprint',
          finding_network: 'google',
          tag_authorization_proof_base64url: 'proof',
          claim_completion_token_base64url: 'completion',
          tag_control_key_base64url: 'control',
          expires_at: '2030-01-01T00:00:00Z',
          claim_deadline: '2030-01-02T00:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        device_id: '22222222-2222-4222-8222-222222222222',
        serial_number: 'PKV-AABBCCDDEEFF',
        status: 'claimed',
        claimed_at: '2026-08-24T00:00:00Z',
        next_action: 'ready',
        finding_network: 'google',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new PinqevaProvisioningClient(
      { baseUrl: 'https://api.pinkeva.com' },
      async () => 'access-token',
    );
    const started = await client.startDeviceClaim({
      provisioningRequestId: '33333333-3333-4333-8333-333333333333',
      serialNumber: 'PKV-AABBCCDDEEFF',
      idempotencyKey: 'provision:test-id',
      tagChallengeBase64url: 'challenge',
      tagAdvertisementKeySha256Base64url: null,
      tagGoogleAdvertisementKeySha256Base64url: null,
      findingNetwork: 'google',
      tagFindingNetwork: null,
    });
    const completed = await client.completeDeviceClaim({
      claim: started,
      tagAdvertisementKeySha256Base64url: 'fingerprint',
      tagGoogleAdvertisementKeySha256Base64url: 'google-fingerprint',
    });

    assert.equal(completed.status, 'claimed');
    assert.equal(requests.length, 2);
    assert.equal(
      new Headers(requests[0]?.init?.headers).get('Authorization'),
      'Bearer access-token',
    );
    assert.equal(
      new Headers(requests[0]?.init?.headers).get('Idempotency-Key'),
      'provision:test-id',
    );
    assert.match(String(requests[1]?.init?.body), /claim_completion_token_base64url/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns only a safe API error code from failed responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'DEVICE_UNAVAILABLE',
          message: 'private database detail',
          request_id: 'safe-correlation-id',
        },
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  try {
    const client = new PinqevaProvisioningClient(
      { baseUrl: 'https://api.pinkeva.com' },
      async () => 'access-token',
    );
    await assert.rejects(
      client.startDeviceClaim({
        provisioningRequestId: '33333333-3333-4333-8333-333333333333',
        serialNumber: 'PKV-AABBCCDDEEFF',
        idempotencyKey: 'provision:test-id',
        tagChallengeBase64url: 'challenge',
        tagAdvertisementKeySha256Base64url: null,
        tagGoogleAdvertisementKeySha256Base64url: null,
        findingNetwork: 'google',
        tagFindingNetwork: null,
      }),
      (error: unknown) =>
        error instanceof ProvisioningApiError &&
        error.code === 'DEVICE_UNAVAILABLE' &&
        error.message === 'DEVICE_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovers, downloads, and acknowledges one authenticated firmware release', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const digest = 'd'.repeat(43);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl.endsWith('/firmware')) {
      return Response.json({
        device_id: '22222222-2222-4222-8222-222222222222',
        current_version: '0.3.0',
        update_available: true,
        latest_version: '0.4.1',
        image_size: 4,
        image_sha256_base64url: digest,
      });
    }
    if (requestUrl.endsWith('/firmware/session')) {
      return Response.json({
        device_id: '22222222-2222-4222-8222-222222222222',
        serial_number: 'PKV-AABBCCDDEEFF',
        version: '0.4.1',
        install_required: true,
        image_size: 4,
        image_sha256_base64url: digest,
        manifest_base64url: 'm'.repeat(154),
        tag_authorization_proof_base64url: 'p'.repeat(43),
        image_url: '/v1/devices/22222222-2222-4222-8222-222222222222/firmware/image?version=0.4.1',
      }, { status: 201 });
    }
    if (requestUrl.includes('/firmware/image?')) {
      return new Response(Uint8Array.of(0xe9, 1, 2, 3), {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    return Response.json({
      device_id: '22222222-2222-4222-8222-222222222222',
      version: '0.4.1',
      status: 'installed',
    });
  }) as typeof fetch;

  try {
    const client = new PinqevaProvisioningClient(
      { baseUrl: 'https://api.pinkeva.com' },
      async () => 'access-token',
    );
    const availability = await client.getFirmwareAvailability(
      '22222222-2222-4222-8222-222222222222',
    );
    const session = await client.startFirmwareUpdateSession({
      deviceId: availability.device_id,
      serialNumber: 'PKV-AABBCCDDEEFF',
      currentVersion: '0.3.0',
      tagChallengeBase64url: 'c'.repeat(43),
    });
    const image = await client.downloadFirmwareImage(session);
    const acknowledgement = await client.acknowledgeFirmwareUpdate({
      deviceId: availability.device_id,
      version: session.version,
      imageSha256Base64url: session.image_sha256_base64url,
    });

    assert.equal(availability.latest_version, '0.4.1');
    assert.deepEqual(image, Uint8Array.of(0xe9, 1, 2, 3));
    assert.equal(acknowledgement.status, 'installed');
    assert.equal(requests.length, 4);
    assert.equal(
      new Headers(requests[2]?.init?.headers).get('Authorization'),
      'Bearer access-token',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
