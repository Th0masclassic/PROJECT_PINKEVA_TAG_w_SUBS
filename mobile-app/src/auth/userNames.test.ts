import assert from 'node:assert/strict';
import test from 'node:test';

import type { User } from '@supabase/supabase-js';

import {
  getUserDisplayName,
  getUserFirstName,
  normalizeUserDisplayName,
} from './userNames.ts';

function user(metadata: Record<string, unknown>, email = 'jane@example.com'): User {
  return { user_metadata: metadata, email } as User;
}

test('normalizes editable display names without accepting control characters', () => {
  assert.equal(normalizeUserDisplayName('  Jane\n  Doe  '), 'Jane Doe');
  assert.equal(normalizeUserDisplayName('\u0000\u0001'), null);
});

test('uses editable full name before provider aliases and a safe email fallback', () => {
  assert.equal(
    getUserDisplayName(user({ full_name: 'Jane Doe', display_name: 'Provider name' })),
    'Jane Doe',
  );
  assert.equal(getUserFirstName(user({ full_name: 'Jane Doe' })), 'Jane');
  assert.equal(getUserDisplayName(user({})), 'jane');
});
