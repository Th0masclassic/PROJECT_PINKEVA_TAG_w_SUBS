import assert from 'node:assert/strict';
import test from 'node:test';

import { safeAuthFeedback } from './authErrors.ts';

test('maps provider failures to fixed safe messages', () => {
  assert.deepEqual(
    safeAuthFeedback({ code: 'invalid_credentials', message: 'sensitive provider detail' }, 'login'),
    { kind: 'error', key: 'auth.signInFailed' },
  );
  assert.deepEqual(safeAuthFeedback({ code: 'weak_password' }, 'register'), {
    kind: 'error',
    key: 'auth.weakPassword',
  });
  assert.deepEqual(safeAuthFeedback({ code: 'over_email_send_rate_limit' }, 'reset'), {
    kind: 'error',
    key: 'auth.tooManyAttempts',
  });
  assert.deepEqual(safeAuthFeedback(new TypeError('Failed to fetch credentials'), 'oauth'), {
    kind: 'error',
    key: 'auth.networkError',
  });
});

test('does not expose account existence, cancellation, or unknown upstream detail', () => {
  assert.deepEqual(safeAuthFeedback({ code: 'user_already_exists' }, 'register'), {
    kind: 'success',
    key: 'auth.checkEmail',
  });
  assert.deepEqual(safeAuthFeedback({ code: 'ERR_REQUEST_CANCELED' }, 'oauth'), {
    kind: 'silent',
  });

  const rawMessage = 'Database response included private account information';
  const feedback = safeAuthFeedback({ code: 'unexpected', message: rawMessage }, 'login');
  assert.deepEqual(feedback, { kind: 'error', key: 'auth.genericError' });
  assert.equal(JSON.stringify(feedback).includes(rawMessage), false);
});
