import * as SecureStore from 'expo-secure-store';

type Backend = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

type Manifest = { version: 1; generation: string; chunks: number };
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 64;
let counter = 0;

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

function baseKey(key: string): string {
  return `pinkeva.admin.auth.${fingerprint(key)}`;
}

function manifestKey(key: string): string {
  return `${baseKey(key)}.manifest`;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `${baseKey(key)}.${generation}.${index}`;
}

function parseManifest(value: string | null): Manifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<Manifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.generation !== 'string' ||
      !/^[a-z0-9]+$/i.test(parsed.generation) ||
      typeof parsed.chunks !== 'number' ||
      !Number.isInteger(parsed.chunks) ||
      parsed.chunks < 1 ||
      parsed.chunks > MAX_CHUNKS
    ) return null;
    return parsed as Manifest;
  } catch {
    return null;
  }
}

async function removeChunks(backend: Backend, key: string, manifest: Manifest | null) {
  if (!manifest) return;
  await Promise.all(
    Array.from({ length: manifest.chunks }, (_, index) =>
      backend.removeItem(chunkKey(key, manifest.generation, index))),
  );
}

export function createChunkedStorage(backend: Backend) {
  return {
    async getItem(key: string) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      if (!manifest) return null;
      const chunks = await Promise.all(
        Array.from({ length: manifest.chunks }, (_, index) =>
          backend.getItem(chunkKey(key, manifest.generation, index))),
      );
      return chunks.some((value) => value === null) ? null : (chunks as string[]).join('');
    },
    async setItem(key: string, value: string) {
      const previous = parseManifest(await backend.getItem(manifestKey(key)));
      counter = (counter + 1) % 1_000_000;
      const generation = `${Date.now().toString(36)}${counter.toString(36)}`;
      const chunks = value.length
        ? Array.from({ length: Math.ceil(value.length / CHUNK_SIZE) }, (_, index) =>
            value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE))
        : [''];
      if (chunks.length > MAX_CHUNKS) throw new Error('Admin session is too large');
      await Promise.all(chunks.map((chunk, index) =>
        backend.setItem(chunkKey(key, generation, index), chunk)));
      await backend.setItem(
        manifestKey(key),
        JSON.stringify({ version: 1, generation, chunks: chunks.length } satisfies Manifest),
      );
      await removeChunks(backend, key, previous);
    },
    async removeItem(key: string) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      await backend.removeItem(manifestKey(key));
      await removeChunks(backend, key, manifest);
    },
  };
}

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'com.pinkeva.admin.auth',
};

export const secureAdminStorage = createChunkedStorage({
  getItem: (key) => SecureStore.getItemAsync(key, secureOptions),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
  removeItem: (key) => SecureStore.deleteItemAsync(key, secureOptions),
});
