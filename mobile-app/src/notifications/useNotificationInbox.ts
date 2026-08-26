import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { ProvisioningApiConfig } from '../provisioning/api';
import {
  getUserNotifications,
  markUserNotificationRead,
  NotificationApiError,
  type NotificationErrorCode,
  type UserNotification,
} from './api';

export type NotificationInbox = {
  notifications: UserNotification[];
  unreadCount: number;
  loading: boolean;
  error: NotificationErrorCode | null;
  refresh: () => Promise<void>;
  markRead: (notificationId: string) => Promise<void>;
};

function errorCode(error: unknown): NotificationErrorCode {
  return error instanceof NotificationApiError ? error.code : 'unavailable';
}

export function useNotificationInbox(input: {
  enabled: boolean;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
}): NotificationInbox {
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NotificationErrorCode | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    if (!input.enabled || !input.apiConfig) {
      setNotifications([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const accessToken = await input.getAccessToken();
      if (!accessToken) throw new NotificationApiError('authentication');
      const next = await getUserNotifications(input.apiConfig, accessToken);
      if (sequence !== requestSequence.current) return;
      setNotifications(next);
    } catch (reason) {
      if (sequence !== requestSequence.current) return;
      setError(errorCode(reason));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [input.apiConfig, input.enabled, input.getAccessToken]);

  const markRead = useCallback(
    async (notificationId: string) => {
      if (!input.enabled || !input.apiConfig) return;
      const accessToken = await input.getAccessToken();
      if (!accessToken) throw new NotificationApiError('authentication');
      await markUserNotificationRead(input.apiConfig, accessToken, notificationId);
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((notification) =>
          notification.id === notificationId && notification.readAt === null
            ? { ...notification, readAt }
            : notification,
        ),
      );
    },
    [input.apiConfig, input.enabled, input.getAccessToken],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!input.enabled) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [input.enabled, refresh]);

  return {
    notifications,
    unreadCount: notifications.filter((notification) => notification.readAt === null).length,
    loading,
    error,
    refresh,
    markRead,
  };
}
