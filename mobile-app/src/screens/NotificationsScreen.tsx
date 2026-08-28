import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { billingErrorMessage, useBillingCopy } from '../billing/copy';
import { formatBillingDate } from '../billing/format';
import { AppSafeArea, BackHeader, OutlineButton, Surface } from '../components';
import { useI18n } from '../i18n';
import type { NotificationErrorCode, UserNotification } from '../notifications/api';
import { colors, radii } from '../theme';

function errorMessage(copy: ReturnType<typeof useBillingCopy>, error: NotificationErrorCode) {
  if (error === 'configuration') return copy.errorConfiguration;
  if (error === 'authentication') return copy.errorAuthentication;
  if (error === 'not_found') return copy.errorNotFound;
  if (error === 'timeout') return copy.errorTimeout;
  if (error === 'invalid_response') return copy.errorInvalidResponse;
  if (error === 'network') return copy.errorNetwork;
  return billingErrorMessage(copy, 'unavailable');
}

function notificationIcon(kind: UserNotification['kind']): ComponentProps<typeof Ionicons>['name'] {
  if (kind === 'admin_message') return 'megaphone-outline';
  if (kind === 'tag_sync_required') return 'shield-checkmark-outline';
  if (kind === 'safe_zone_enter') return 'enter-outline';
  if (kind === 'safe_zone_exit') return 'exit-outline';
  if (kind === 'lost_mode_location') return 'location-outline';
  if (kind === 'movement_detected') return 'navigate-outline';
  if (kind === 'expired') return 'alert-circle-outline';
  return 'notifications-outline';
}

export function NotificationsScreen({
  notifications,
  loading,
  error,
  onBack,
  onRetry,
  onOpenSubscription,
  onMarkRead,
}: {
  notifications: readonly UserNotification[];
  loading: boolean;
  error: NotificationErrorCode | null;
  onBack: () => void;
  onRetry: () => Promise<void>;
  onOpenSubscription: (deviceId: string) => void;
  onMarkRead: (notificationId: string) => Promise<void>;
}) {
  const { language, t } = useI18n();
  const copy = useBillingCopy();

  return (
    <AppSafeArea>
      <BackHeader title={t('settings.notifications')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.subtitle}>{t('settings.notificationsMessage')}</Text>

        {error ? (
          <Surface style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={26} color={colors.danger} />
            <Text style={styles.errorText}>{errorMessage(copy, error)}</Text>
            <OutlineButton label={copy.retry} onPress={() => void onRetry()} />
          </Surface>
        ) : null}

        {loading && !notifications.length ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.blue} />
          </View>
        ) : notifications.length ? (
          <View style={styles.notificationList}>
            {notifications.map((notification) => {
              const unread = notification.readAt === null;
              return (
                <Pressable
                  key={notification.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${notification.title}. ${notification.body}`}
                  onPress={() => {
                    if (unread) void onMarkRead(notification.id).catch(() => undefined);
                    if (notification.deviceId) onOpenSubscription(notification.deviceId);
                  }}
                  style={({ pressed }) => [
                    styles.notificationRow,
                    unread && styles.notificationRowUnread,
                    pressed && styles.pressed,
                  ]}
                  testID={`notification-${notification.id}`}
                >
                  <View style={[styles.notificationIcon, unread && styles.notificationIconUnread]}>
                    <Ionicons
                      name={notificationIcon(notification.kind)}
                      size={23}
                      color={unread ? colors.blue : colors.mutedDark}
                    />
                  </View>
                  <View style={styles.notificationCopy}>
                    <View style={styles.notificationTitleRow}>
                      <Text style={[styles.notificationTitle, unread && styles.notificationTitleUnread]}>
                        {notification.title}
                      </Text>
                      {unread ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text style={styles.notificationBody}>{notification.body}</Text>
                    <Text style={styles.notificationDate}>
                      {formatBillingDate(notification.createdAt, language) ?? '—'}
                    </Text>
                  </View>
                  {notification.deviceId ? <Ionicons name="chevron-forward" size={22} color={colors.muted} /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Surface style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="checkmark-done-outline" size={31} color={colors.blue} />
            </View>
            <Text style={styles.emptyTitle}>{t('home.notificationsClear')}</Text>
            <Text style={styles.emptyBody}>{t('settings.notificationsMessage')}</Text>
          </Surface>
        )}
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 4, paddingBottom: 36, gap: 16 },
  subtitle: { color: colors.muted, fontSize: 16, lineHeight: 23, textAlign: 'center' },
  loadingWrap: { minHeight: 180, alignItems: 'center', justifyContent: 'center' },
  errorCard: { padding: 18, gap: 12 },
  errorText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  notificationList: { overflow: 'hidden', borderRadius: radii.large, backgroundColor: colors.surface },
  notificationRow: {
    minHeight: 94,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  notificationRowUnread: { backgroundColor: '#F5F8FF' },
  notificationIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F2F6',
  },
  notificationIconUnread: { backgroundColor: colors.bluePale },
  notificationCopy: { flex: 1, gap: 4 },
  notificationTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  notificationTitle: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  notificationTitleUnread: { fontWeight: '800' },
  notificationBody: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  notificationDate: { color: colors.muted, fontSize: 12, marginTop: 2 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue },
  emptyCard: { alignItems: 'center', padding: 28, gap: 9 },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bluePale,
  },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginTop: 5 },
  emptyBody: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  pressed: { opacity: 0.72 },
});
