/** Platform-neutral SHA-256 for native, web, and the Node test runner. */
export async function sha256Digest(value: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(value.length);
  input.set(value);
  try {
    if (globalThis.crypto?.subtle) {
      return new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', input),
      );
    }
    const { CryptoDigestAlgorithm, digest } = await import('expo-crypto');
    return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, input));
  } finally {
    input.fill(0);
  }
}
