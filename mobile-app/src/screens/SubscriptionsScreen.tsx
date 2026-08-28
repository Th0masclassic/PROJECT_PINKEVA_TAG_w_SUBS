import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useBillingCopy } from '../billing/copy';
import { billingIntervalLabel, formatBillingMoney, localizedBillingPlanName } from '../billing/format';
import { SubscriptionBadge } from '../billing/SubscriptionBadge';
import { type BillingPlan, type DeviceSubscription } from '../billing/types';
import {
  AppSafeArea,
  PrimaryButton,
  ScreenTitle,
  Surface,
  TrackerArtwork,
} from '../components';
import { useI18n } from '../i18n';
import type { Tracker } from '../model';
import { colors, radii, shadow } from '../theme';

function collectAvailablePlans(
  trackers: readonly Tracker[],
  subscriptions: Record<string, DeviceSubscription>,
): BillingPlan[] {
  const plans = new Map<string, BillingPlan>();
  for (const tracker of trackers) {
    for (const plan of subscriptions[tracker.id]?.availablePlans ?? []) {
      plans.set(plan.code, plan);
    }
  }
  return [...plans.values()].sort(
    (left, right) =>
      left.amountMinor - right.amountMinor ||
      left.durationMonths - right.durationMonths ||
      left.code.localeCompare(right.code),
  );
}

export function SubscriptionsScreen({
  trackers,
  subscriptions,
  subscriptionLoadingIds,
  onOpenSubscription,
  onAddTracker,
}: {
  trackers: readonly Tracker[];
  subscriptions: Record<string, DeviceSubscription>;
  subscriptionLoadingIds: ReadonlySet<string>;
  onOpenSubscription: (trackerId: string) => void;
  onAddTracker: () => void;
}) {
  const { language, t } = useI18n();
  const copy = useBillingCopy();
  const managedTrackers = trackers.filter((tracker) => tracker.source !== 'local-preview');
  const availablePlans = collectAvailablePlans(managedTrackers, subscriptions);
  const featuredPlan = availablePlans[availablePlans.length - 1];

  return (
    <AppSafeArea>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="subscriptions-screen"
      >
        <ScreenTitle title={copy.subscription} subtitle={copy.subscriptionSubtitle} />

        <Surface style={styles.introCard}>
          <View style={styles.introIcon}>
            <Ionicons name="card" size={27} color={colors.blue} />
          </View>
          <View style={styles.introCopy}>
            <Text style={styles.introTitle}>{copy.subscription}</Text>
            <Text style={styles.introBody}>{copy.perTag}</Text>
          </View>
          <View style={styles.secureRow}>
            <Ionicons name="shield-checkmark-outline" size={21} color={colors.blue} />
            <Text style={styles.secureText}>{copy.secureNotice}</Text>
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{copy.plans}</Text>
          <Text style={styles.sectionBody}>{copy.choosePlan}</Text>
        </View>

        {availablePlans.length ? (
          <View style={styles.planGrid}>
            {availablePlans.map((plan) => {
              const featured = plan.code === featuredPlan?.code;
              const price = formatBillingMoney(plan.amountMinor, plan.currency, language);
              const interval = billingIntervalLabel(
                plan.interval,
                copy.month,
                copy.year,
                plan.intervalCount,
              );
              return (
                <Surface
                  key={plan.code}
                  style={[styles.planCard, featured ? styles.planCardFeatured : {}]}
                  accessibilityLabel={localizedBillingPlanName(plan.code, plan.name, language)}
                >
                  <View style={[styles.planIcon, featured && styles.planIconFeatured]}>
                    <Ionicons
                      name={featured ? 'star' : 'time-outline'}
                      size={19}
                      color={featured ? '#FFFFFF' : colors.blue}
                    />
                  </View>
                  <Text style={[styles.planName, featured && styles.planNameFeatured]}>
                    {localizedBillingPlanName(plan.code, plan.name, language)}
                  </Text>
                  <Text style={[styles.planPrice, featured && styles.planPriceFeatured]}>
                    {price} / {interval}
                  </Text>
                </Surface>
              );
            })}
          </View>
        ) : (
          <Surface style={styles.noPlansCard}>
            {subscriptionLoadingIds.size ? <ActivityIndicator color={colors.blue} /> : null}
            <Ionicons name="hourglass-outline" size={24} color={colors.muted} />
            <Text style={styles.noPlansText}>{copy.noPlans}</Text>
          </Surface>
        )}

        <View style={styles.tagsHeader}>
          <Text style={styles.sectionTitle}>{t('common.trackers')}</Text>
          <Text style={styles.sectionBody}>{copy.perTag}</Text>
        </View>

        {managedTrackers.length ? (
          <View style={styles.tagList}>
            {managedTrackers.map((tracker) => (
              <Pressable
                key={tracker.id}
                accessibilityRole="button"
                accessibilityLabel={`${copy.subscription}, ${tracker.name}`}
                onPress={() => onOpenSubscription(tracker.id)}
                style={({ pressed }) => [styles.tagRow, pressed && styles.pressed]}
                testID={`subscription-overview-${tracker.id}`}
              >
                <View style={styles.tagArtwork}>
                  <TrackerArtwork kind={tracker.kind} style={styles.tagArtworkImage} decorative />
                </View>
                <View style={styles.tagCopy}>
                  <Text numberOfLines={1} style={styles.tagName}>
                    {tracker.name}
                  </Text>
                  <SubscriptionBadge
                    compact
                    subscription={subscriptions[tracker.id]}
                    loading={subscriptionLoadingIds.has(tracker.id)}
                  />
                  {subscriptions[tracker.id]?.amountMinor !== null &&
                  subscriptions[tracker.id]?.amountMinor !== undefined ? (
                    <Text style={styles.tagPrice}>
                      {formatBillingMoney(
                        subscriptions[tracker.id]?.amountMinor ?? null,
                        subscriptions[tracker.id]?.currency ?? null,
                        language,
                      )}{' '}
                      /{' '}
                      {billingIntervalLabel(
                        subscriptions[tracker.id]?.interval ?? null,
                        copy.month,
                        copy.year,
                        subscriptions[tracker.id]?.intervalCount ?? 1,
                      )}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={24} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : (
          <Surface style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="pricetag-outline" size={27} color={colors.blue} />
            </View>
            <Text style={styles.emptyTitle}>{t('trackers.emptyTitle')}</Text>
            <Text style={styles.emptyBody}>{t('trackers.emptyBody')}</Text>
            <PrimaryButton
              label={t('trackers.add')}
              icon="add-circle-outline"
              onPress={onAddTracker}
              style={styles.emptyButton}
              testID="subscriptions-add-tracker"
            />
          </Surface>
        )}

      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 36, gap: 18 },
  introCard: { padding: 18, borderRadius: radii.large, gap: 14 },
  introIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bluePale,
  },
  introCopy: { gap: 6 },
  introTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  introBody: { color: colors.mutedDark, fontSize: 15, lineHeight: 22 },
  secureRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 13,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  secureText: { color: colors.mutedDark, flex: 1, fontSize: 13, lineHeight: 19 },
  sectionHeader: { gap: 5 },
  tagsHeader: { gap: 5, marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  sectionBody: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  planGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  planCard: {
    width: '47.8%',
    minHeight: 124,
    borderRadius: radii.medium,
    padding: 14,
    justifyContent: 'space-between',
  },
  planCardFeatured: { backgroundColor: colors.blue, borderColor: colors.blue },
  planIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bluePale,
  },
  planIconFeatured: { backgroundColor: 'rgba(255,255,255,0.2)' },
  planName: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 9 },
  planNameFeatured: { color: '#FFFFFF' },
  planPrice: { color: colors.mutedDark, fontSize: 13, fontWeight: '700', marginTop: 3 },
  planPriceFeatured: { color: '#EAF1FF' },
  noPlansCard: { padding: 20, alignItems: 'center', gap: 9 },
  noPlansText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  tagList: { overflow: 'hidden', borderRadius: radii.large, backgroundColor: colors.surface, ...shadow },
  tagRow: {
    minHeight: 88,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tagArtwork: {
    width: 70,
    height: 58,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F7F9FE',
  },
  tagArtworkImage: { width: '100%', height: '100%' },
  tagCopy: { flex: 1, gap: 7 },
  tagName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  tagPrice: { color: colors.mutedDark, fontSize: 13, fontWeight: '700' },
  emptyCard: { alignItems: 'center', padding: 22, borderRadius: radii.large },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bluePale,
    marginBottom: 12,
  },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8 },
  emptyButton: { width: '100%', marginTop: 18 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
