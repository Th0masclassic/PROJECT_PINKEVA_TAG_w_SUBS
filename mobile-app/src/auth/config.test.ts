import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSupabasePublicConfig } from './config.ts';

test('accepts only trimmed HTTPS Supabase client configuration', () => {
  assert.deepEqual(
    parseSupabasePublicConfig(' https://example.supabase.co/ ', ' sb_publishable_test '),
    {
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_test',
    },
  );

  assert.equal(parseSupabasePublicConfig('http://example.supabase.co', 'key'), null);
  assert.equal(parseSupabasePublicConfig('https://user@example.supabase.co', 'key'), null);
  assert.equal(parseSupabasePublicConfig('https://example.supabase.co?secret=1', 'key'), null);
  assert.equal(parseSupabasePublicConfig('https://example.supabase.co', ''), null);
});
