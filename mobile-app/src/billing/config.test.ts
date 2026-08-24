import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLoopbackHostname,
  parseBillingApiConfig,
} from './config.ts';

test('billing API accepts HTTPS and strips one trailing slash', () => {
  assert.deepEqual(parseBillingApiConfig('https://api.pinkeva.example/'), {
    baseUrl: 'https://api.pinkeva.example',
  });
});

test('plain HTTP is accepted only on loopback', () => {
  assert.deepEqual(parseBillingApiConfig('http://127.0.0.1:8000/'), {
    baseUrl: 'http://127.0.0.1:8000',
  });
  assert.deepEqual(parseBillingApiConfig('http://[::1]:8000'), {
    baseUrl: 'http://[::1]:8000',
  });
  assert.equal(parseBillingApiConfig('http://192.168.1.20:8000'), null);
  assert.equal(parseBillingApiConfig('http://api.pinkeva.example'), null);
  assert.equal(isLoopbackHostname('127.42.1.8'), true);
  assert.equal(isLoopbackHostname('128.0.0.1'), false);
});

test('API base rejects credentials, query, and fragments', () => {
  assert.equal(parseBillingApiConfig('https://user:pass@example.com'), null);
  assert.equal(parseBillingApiConfig('https://example.com?token=secret'), null);
  assert.equal(parseBillingApiConfig('https://example.com/#fragment'), null);
});
