import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAdminPublicConfig, parseHttpsUrl } from './config.ts';

test('accepts only credential-free HTTPS endpoints', () => {
  assert.equal(parseHttpsUrl(' https://api.example.com/ '), 'https://api.example.com');
  assert.equal(parseHttpsUrl('http://api.example.com'), null);
  assert.equal(parseHttpsUrl('https://user@api.example.com'), null);
  assert.equal(parseHttpsUrl('https://api.example.com?secret=x'), null);
});

test('requires all public Admin configuration values', () => {
  assert.deepEqual(
    parseAdminPublicConfig({
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: ' sb_publishable_test ',
      apiUrl: 'https://api.example.com/',
    }),
    {
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'sb_publishable_test',
      apiUrl: 'https://api.example.com',
    },
  );
  assert.equal(
    parseAdminPublicConfig({
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: '',
      apiUrl: 'https://api.example.com',
    }),
    null,
  );
});
