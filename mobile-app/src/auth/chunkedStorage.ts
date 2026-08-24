export type KeyValueStorageBackend = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type AuthStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

type Manifest = {
  version: 1;
  generation: string;
  chunks: number;
};

const DEFAULT_CHUNK_SIZE = 1800;
const MAX_CHUNKS = 64;
let generationCounter = 0;

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

function baseKey(key: string): string {
  return `pinkeva.auth.${fingerprint(key)}`;
}

function manifestKey(key: string): string {
  return `${baseKey(key)}.manifest`;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `${baseKey(key)}.${generation}.${index}`;
}

function parseManifest(raw: string | null): Manifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Manifest>;
    if (
      value.version !== 1 ||
      typeof value.generation !== 'string' ||
      !/^[a-z0-9]+$/i.test(value.generation) ||
      !Number.isInteger(value.chunks) ||
      typeof value.chunks !== 'number' ||
      value.chunks < 1 ||
      value.chunks > MAX_CHUNKS
    ) {
      return null;
    }
    return value as Manifest;
  } catch {
    return null;
  }
}

function nextGeneration(): string {
  generationCounter = (generationCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${generationCounter.toString(36)}`;
}

async function removeChunks(
  backend: KeyValueStorageBackend,
  key: string,
  manifest: Manifest | null,
): Promise<void> {
  if (!manifest) return;
  await Promise.all(
    Array.from({ length: manifest.chunks }, (_, index) =>
      backend.removeItem(chunkKey(key, manifest.generation, index)),
    ),
  );
}

/**
 * SecureStore historically rejects large values on some OS versions. This adapter stores a
 * generation manifest last, so an interrupted write continues to point at the prior complete value.
 */
export function createChunkedStorage(
  backend: KeyValueStorageBackend,
  chunkSize = DEFAULT_CHUNK_SIZE,
): AuthStorage {
  if (!Number.isInteger(chunkSize) || chunkSize < 256) {
    throw new TypeError('chunkSize must be an integer of at least 256 bytes');
  }

  return {
    async getItem(key) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      if (!manifest) return null;

      const chunks = await Promise.all(
        Array.from({ length: manifest.chunks }, (_, index) =>
          backend.getItem(chunkKey(key, manifest.generation, index)),
        ),
      );
      if (chunks.some((chunk) => chunk === null)) return null;
      return (chunks as string[]).join('');
    },

    async setItem(key, value) {
      const oldManifest = parseManifest(await backend.getItem(manifestKey(key)));
      const generation = nextGeneration();
      const chunks = value.length
        ? Array.from({ length: Math.ceil(value.length / chunkSize) }, (_, index) =>
            value.slice(index * chunkSize, (index + 1) * chunkSize),
          )
        : [''];

      if (chunks.length > MAX_CHUNKS) {
        throw new Error('Auth session is too large for secure storage');
      }

      await Promise.all(
        chunks.map((chunk, index) => backend.setItem(chunkKey(key, generation, index), chunk)),
      );
      const manifest: Manifest = { version: 1, generation, chunks: chunks.length };
      await backend.setItem(manifestKey(key), JSON.stringify(manifest));
      await removeChunks(backend, key, oldManifest);
    },

    async removeItem(key) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      await backend.removeItem(manifestKey(key));
      await removeChunks(backend, key, manifest);
    },
  };
}
