import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChunkedStorage,
  type KeyValueStorageBackend,
} from './chunkedStorage.ts';

function memoryBackend() {
  const values = new Map<string, string>();
  let rejectValue: ((value: string) => boolean) | null = null;
  const backend: KeyValueStorageBackend = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      if (rejectValue?.(value)) throw new Error('simulated interrupted write');
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
  return {
    backend,
    rejectWhen(predicate: ((value: string) => boolean) | null) {
      rejectValue = predicate;
    },
  };
}

test('round-trips, replaces, and removes sessions larger than SecureStore limits', async () => {
  const memory = memoryBackend();
  const storage = createChunkedStorage(memory.backend, 256);
  const first = 'session-a'.repeat(850);
  const second = 'session-b'.repeat(400);

  await storage.setItem('supabase.session', first);
  assert.equal(await storage.getItem('supabase.session'), first);

  await storage.setItem('supabase.session', second);
  assert.equal(await storage.getItem('supabase.session'), second);

  await storage.removeItem('supabase.session');
  assert.equal(await storage.getItem('supabase.session'), null);
});

test('keeps the previous complete session when a replacement write is interrupted', async () => {
  const memory = memoryBackend();
  const storage = createChunkedStorage(memory.backend, 256);
  const previous = 'old-session'.repeat(80);

  await storage.setItem('supabase.session', previous);
  memory.rejectWhen((value) => value.startsWith('new-session'));

  await assert.rejects(storage.setItem('supabase.session', 'new-session'.repeat(80)));
  assert.equal(await storage.getItem('supabase.session'), previous);
});

test('rejects values too large for the bounded secure-store namespace', async () => {
  const memory = memoryBackend();
  const storage = createChunkedStorage(memory.backend, 256);
  await assert.rejects(
    storage.setItem('supabase.session', 'x'.repeat(256 * 65)),
    /too large/,
  );
});
