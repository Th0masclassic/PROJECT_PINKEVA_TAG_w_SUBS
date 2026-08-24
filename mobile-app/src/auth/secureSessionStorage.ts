import * as SecureStore from 'expo-secure-store';

import { createChunkedStorage } from './chunkedStorage';

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'com.pinkeva.mobile.auth',
};

export const secureSessionStorage = createChunkedStorage({
  getItem: (key) => SecureStore.getItemAsync(key, secureStoreOptions),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secureStoreOptions),
  removeItem: (key) => SecureStore.deleteItemAsync(key, secureStoreOptions),
});
