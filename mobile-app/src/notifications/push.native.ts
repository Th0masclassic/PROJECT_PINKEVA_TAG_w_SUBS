import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import type { ProvisioningApiConfig } from '../provisioning/api';


const INSTALLATION_ID_KEY = 'pinqeva.push.installation-id.v1';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RegisteredDestination = {
  apiConfig: ProvisioningApiConfig;
  accessToken: string;
  installationId: string;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function installationId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
  if (stored && UUID_PATTERN.test(stored)) return stored;
  const created = randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_ID_KEY, created, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return created;
}

function easProjectId(): string | null {
  const value =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function register(input: {
  apiConfig: ProvisioningApiConfig;
  getAccessToken: () => Promise<string | null>;
  devicePushToken?: Notifications.DevicePushToken;
}): Promise<RegisteredDestination | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('subscription-renewals', {
      name: 'Subscription renewals',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 150, 250],
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const permission =
    current.status === 'granted'
      ? current
      : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return null;

  const projectId = easProjectId();
  if (!projectId) return null;

  const [token, id, accessToken] = await Promise.all([
    Notifications.getExpoPushTokenAsync({
      projectId,
      devicePushToken: input.devicePushToken,
    }),
    installationId(),
    input.getAccessToken(),
  ]);
  if (!accessToken) return null;
  const response = await fetch(
    `${input.apiConfig.baseUrl}/v1/notifications/push-token`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        installation_id: id,
        expo_push_token: token.data,
        platform: Platform.OS,
      }),
    },
  );
  if (!response.ok) throw new Error('PUSH_TOKEN_REGISTRATION_FAILED');
  return { apiConfig: input.apiConfig, accessToken, installationId: id };
}

async function unregister(destination: RegisteredDestination): Promise<void> {
  await fetch(
    `${destination.apiConfig.baseUrl}/v1/notifications/push-token/${destination.installationId}`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${destination.accessToken}`,
      },
    },
  );
}

export function useRenewalPushRegistration(input: {
  enabled: boolean;
  userId: string | null;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
}): void {
  const destination = useRef<RegisteredDestination | null>(null);
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    if (previousUserId.current && !input.userId && destination.current) {
      const registered = destination.current;
      destination.current = null;
      void unregister(registered).catch(() => undefined);
    }
    previousUserId.current = input.userId;
  }, [input.userId]);

  useEffect(() => {
    if (!input.enabled || !input.userId || !input.apiConfig) return;
    const apiConfig = input.apiConfig;
    let active = true;
    let tokenListener: ReturnType<typeof Notifications.addPushTokenListener> | null = null;
    const timer = setTimeout(() => {
      if (!active) return;
      void register({
        apiConfig,
        getAccessToken: input.getAccessToken,
      })
        .then((registered) => {
          if (!active || !registered) return;
          destination.current = registered;
          tokenListener = Notifications.addPushTokenListener(
            (devicePushToken) => {
              void register({
                apiConfig,
                getAccessToken: input.getAccessToken,
                devicePushToken,
              })
                .then((updated) => {
                  if (active && updated) destination.current = updated;
                })
                .catch(() => undefined);
            },
          );
        })
        .catch((error: unknown) => {
          if (__DEV__) {
            console.warn('[Pinkeva notifications] registration failed', {
              name: error instanceof Error ? error.name : typeof error,
            });
          }
        });
    }, 750);
    return () => {
      active = false;
      clearTimeout(timer);
      tokenListener?.remove();
    };
  }, [input.apiConfig, input.enabled, input.getAccessToken, input.userId]);
}
