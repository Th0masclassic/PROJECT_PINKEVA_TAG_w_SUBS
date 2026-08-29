import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getUserNotifications,
  markUserNotificationRead,
  NotificationApiError,
  parseUserNotifications,
} from './api.ts';

const NOTIFICATION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const payload = {
  notifications: [
    {
      id: NOTIFICATION_ID,
      device_id: DEVICE_ID,
      kind: 'renewal_1_day',
      period_end: '2099-09-01T00:00:00Z',
      title: 'Subscription renews tomorrow',
      body: 'The subscription is scheduled to renew automatically tomorrow.',
      created_at: '2099-08-01T00:00:00Z',
      read_at: null,
    },
  ],
};

test('parses the durable renewal notification inbox contract', () => {
  assert.deepEqual(parseUserNotifications(payload), [
    {
      id: NOTIFICATION_ID,
      deviceId: DEVICE_ID,
      kind: 'renewal_1_day',
      periodEnd: '2099-09-01T00:00:00Z',
      title: 'Subscription renews tomorrow',
      body: 'The subscription is scheduled to renew automatically tomorrow.',
      createdAt: '2099-08-01T00:00:00Z',
      readAt: null,
    },
  ]);
});

test('parses premium tracker alerts without a billing period', () => {
  const premiumPayload = {
    notifications: [
      {
        ...payload.notifications[0],
        kind: 'separation_detected',
        period_end: null,
        title: 'Keys left Home',
        body: 'Keys moved outside your Home safe zone.',
      },
    ],
  };

  assert.equal(parseUserNotifications(premiumPayload)[0]?.kind, 'separation_detected');
  assert.equal(parseUserNotifications(premiumPayload)[0]?.periodEnd, null);
});

test('rejects malformed notification inbox payloads', () => {
  assert.throws(
    () => parseUserNotifications({ notifications: [{ ...payload.notifications[0], device_id: 'bad' }] }),
    (error) => error instanceof NotificationApiError && error.code === 'invalid_response',
  );
});

test('loads and acknowledges notifications with bearer authentication', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/read')) {
      return new Response(JSON.stringify({ id: NOTIFICATION_ID, status: 'read' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const config = { baseUrl: 'https://api.pinkeva.example' };
    await getUserNotifications(config, 'access-token');
    await markUserNotificationRead(config, 'access-token', NOTIFICATION_ID);

    assert.deepEqual(calls.map((call) => call.input), [
      'https://api.pinkeva.example/v1/notifications?limit=25',
      `https://api.pinkeva.example/v1/notifications/${NOTIFICATION_ID}/read`,
    ]);
    assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer access-token');
    assert.equal((calls[1]?.init?.headers as Record<string, string>).Authorization, 'Bearer access-token');
    assert.equal(calls[1]?.init?.method, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
