import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BillingApiError,
  createDeviceCheckout,
  createDevicePortal,
  getDeviceSubscription,
  parseDeviceSubscription,
  safeBillingErrorCode,
} from './api.ts';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const subscriptionPayload = {
  device_id: DEVICE_ID,
  status: 'active',
  plan_code: 'monthly_basic',
  plan_name: 'Monthly',
  amount_minor: 299,
  currency: 'eur',
  billing_interval: 'monthly',
  billing_interval_count: 1,
  duration_months: 1,
  current_period_start: '2026-08-01T00:00:00Z',
  current_period_end: '2026-09-01T00:00:00Z',
  cancel_at_period_end: false,
  available_plans: [
    {
      code: 'monthly_basic',
      name: 'Monthly',
      amount_minor: 299,
      currency: 'EUR',
      billing_interval: 'month',
      billing_interval_count: 1,
      duration_months: 1,
    },
  ],
};

test('parses the per-device subscription contract', () => {
  assert.deepEqual(parseDeviceSubscription(subscriptionPayload, DEVICE_ID), {
    deviceId: DEVICE_ID,
    status: 'active',
    planCode: 'monthly_basic',
    planName: 'Monthly',
    amountMinor: 299,
    currency: 'EUR',
    interval: 'month',
    intervalCount: 1,
    durationMonths: 1,
    currentPeriodStart: '2026-08-01T00:00:00Z',
    currentPeriodEnd: '2026-09-01T00:00:00Z',
    cancelAtPeriodEnd: false,
    availablePlans: [
      {
        code: 'monthly_basic',
        name: 'Monthly',
        amountMinor: 299,
        currency: 'EUR',
        interval: 'month',
        intervalCount: 1,
        durationMonths: 1,
      },
    ],
  });
});

test('rejects a subscription for a different device', () => {
  assert.throws(
    () =>
      parseDeviceSubscription(
        subscriptionPayload,
        '22222222-2222-4222-8222-222222222222',
      ),
    (error) => error instanceof BillingApiError && error.code === 'invalid_response',
  );
});

test('API calls send bearer auth and exact per-tag routes', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/checkout')) {
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/example' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(input).endsWith('/portal')) {
      return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/example' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(subscriptionPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const config = { baseUrl: 'https://api.pinkeva.example' };
    await getDeviceSubscription(config, 'access-token', DEVICE_ID);
    await createDeviceCheckout(config, 'access-token', DEVICE_ID, 'monthly_basic');
    await createDevicePortal(config, 'access-token', DEVICE_ID);
    await createDevicePortal(config, 'access-token', DEVICE_ID, 'cancel');

    assert.deepEqual(calls.map((call) => call.input), [
      `https://api.pinkeva.example/v1/devices/${DEVICE_ID}/subscription`,
      `https://api.pinkeva.example/v1/devices/${DEVICE_ID}/subscription/checkout`,
      `https://api.pinkeva.example/v1/devices/${DEVICE_ID}/subscription/portal`,
      `https://api.pinkeva.example/v1/devices/${DEVICE_ID}/subscription/portal`,
    ]);
    for (const call of calls) {
      assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer access-token');
    }
    assert.equal(calls[1]?.init?.method, 'POST');
    assert.equal(calls[1]?.init?.body, JSON.stringify({ plan_code: 'monthly_basic' }));
    assert.equal(calls[2]?.init?.method, 'POST');
    assert.equal(calls[2]?.init?.body, JSON.stringify({ action: 'update' }));
    assert.equal(calls[3]?.init?.body, JSON.stringify({ action: 'cancel' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps server errors without exposing response details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: 'sensitive database error' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => getDeviceSubscription({ baseUrl: 'https://api.example' }, 'token', DEVICE_ID),
      (error) =>
        error instanceof BillingApiError &&
        error.code === 'authentication' &&
        !error.message.includes('sensitive'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('safe errors expose stable categories only', () => {
  assert.equal(safeBillingErrorCode(new BillingApiError('rate_limited', 429)), 'rate_limited');
  assert.equal(safeBillingErrorCode(new Error('private transport detail')), 'network');
});

test('rejects non-UUID device IDs before making a billing request', async () => {
  await assert.rejects(
    () => getDeviceSubscription(
      { baseUrl: 'https://api.example' },
      'token',
      'local-demo-id',
    ),
    (error) => error instanceof BillingApiError && error.code === 'invalid_response',
  );
});

test('accepts only the expected Stripe host for each billing destination', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ url: 'https://phishing.example/stripe-lookalike' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        createDeviceCheckout(
          { baseUrl: 'https://api.example' },
          'token',
          DEVICE_ID,
          'monthly_basic',
        ),
      (error) => error instanceof BillingApiError && error.code === 'invalid_response',
    );
    await assert.rejects(
      () => createDevicePortal({ baseUrl: 'https://api.example' }, 'token', DEVICE_ID),
      (error) => error instanceof BillingApiError && error.code === 'invalid_response',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects plan codes outside the backend contract', async () => {
  await assert.rejects(
    () =>
      createDeviceCheckout(
        { baseUrl: 'https://api.example' },
        'token',
        DEVICE_ID,
        '_not-valid',
      ),
    (error) => error instanceof BillingApiError && error.code === 'invalid_response',
  );
});
