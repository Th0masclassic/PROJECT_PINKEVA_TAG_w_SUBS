import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const INSTALLATION_ID_KEY = 'pinqeva.push.installation-id.v1';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getInstallationId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
  if (stored && UUID_PATTERN.test(stored)) return stored.toLowerCase();
  const created = randomUUID().toLowerCase();
  await SecureStore.setItemAsync(INSTALLATION_ID_KEY, created, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return created;
}
