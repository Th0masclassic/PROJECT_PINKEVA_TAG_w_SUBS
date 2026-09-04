import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { subscriptionStatusLabel, useBillingCopy } from './copy';
import type { AccountSubscription } from './types';

export function SubscriptionBadge({
  subscription,
  loading = false,
  compact = false,
}: {
  subscription?: AccountSubscription;
  loading?: boolean;
  compact?: boolean;
}) {
  const copy = useBillingCopy();
  const attention =
    subscription?.cancelAtPeriodEnd ||
    ['past_due', 'unpaid', 'incomplete'].includes(subscription?.status ?? '');
  const inactive = !subscription ||
    ['none', 'canceled', 'ended', 'incomplete_expired', 'unknown'].includes(subscription.status);
  const tint = attention ? '#9A5A00' : inactive ? colors.mutedDark : colors.blue;
  const background = attention ? '#FFF4DA' : inactive ? '#F0F2F6' : colors.bluePale;

  return (
    <View
      accessibilityLabel={`${copy.subscription}: ${subscriptionStatusLabel(copy, subscription)}`}
      style={[styles.badge, { backgroundColor: background }, compact && styles.compact]}
    >
      {loading ? (
        <ActivityIndicator color={tint} size="small" />
      ) : (
        <Ionicons name={inactive ? 'card-outline' : 'checkmark-circle'} color={tint} size={compact ? 14 : 17} />
      )}
      <Text numberOfLines={1} style={[styles.label, { color: tint }, compact && styles.compactLabel]}>
        {loading ? copy.loading : subscriptionStatusLabel(copy, subscription)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minHeight: 34,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  compact: { minHeight: 28, paddingHorizontal: 9 },
  label: { fontSize: 13, fontWeight: '800', maxWidth: 190 },
  compactLabel: { fontSize: 11, maxWidth: 150 },
});
