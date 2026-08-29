import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAccountBillingCopy } from '../billing/accountCopy';
import { CloudPlusFeatures } from '../billing/CloudPlusFeatures';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import {
  billingErrorMessage,
  subscriptionStatusLabel,
  useBillingCopy,
} from '../billing/copy';
import {
  billingIntervalLabel,
  formatBillingDate,
  formatBillingMoney,
  localizedBillingPlanName,
} from '../billing/format';
import { SubscriptionBadge } from '../billing/SubscriptionBadge';
import {
  isCurrentSubscription,
  type BillingActionResult,
  type BillingErrorCode,
  type BillingMode,
  type BillingPlan,
  type BillingPortalAction,
  type DeviceSubscription,
} from '../billing/types';
import {
  AppSafeArea,
  OutlineButton,
  PrimaryButton,
  ScreenTitle,
  Surface,
} from '../components';
import { useI18n } from '../i18n';
import { colors, radii } from '../theme';

const EMPTY_PLANS: BillingPlan[] = [];

export function SubscriptionsScreen({
  subscription,
  loading,
  error,
  mode,
  purchasesEnabled,
  checkoutAvailable,
  onRetry,
  onCheckout,
  onPortal,
  onNotice,
}: {
  subscription?: DeviceSubscription;
  loading: boolean;
  error?: BillingErrorCode;
  mode: BillingMode;
  purchasesEnabled: boolean;
  checkoutAvailable: boolean;
  onRetry: () => Promise<void>;
  onCheckout: (planCode: string) => Promise<BillingActionResult>;
  onPortal: (action: BillingPortalAction) => Promise<BillingActionResult>;
  onNotice: (message: string) => void;
}) {
  const { language } = useI18n();
  const accountCopy = useAccountBillingCopy();
  const billingCopy = useBillingCopy();
  const cloudCopy = useCloudPlusCopy();
  const plans = subscription?.availablePlans ?? EMPTY_PLANS;
  const current = subscription ? isCurrentSubscription(subscription) : false;
  const [selectedPlanCode, setSelectedPlanCode] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    const preferred = plans.find((plan) => plan.code === selectedPlanCode)?.code
      ?? plans.find((plan) => plan.code === subscription?.planCode)?.code
      ?? plans[0]?.code
      ?? null;
    setSelectedPlanCode(preferred);
  }, [plans, selectedPlanCode, subscription?.planCode]);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.code === selectedPlanCode),
    [plans, selectedPlanCode],
  );
  const currentPlanName =
    subscription?.planCode && subscription.planName
      ? localizedBillingPlanName(subscription.planCode, subscription.planName, language)
      : null;
  const periodEnd = formatBillingDate(subscription?.currentPeriodEnd ?? null, language);

  const presentResult = (result: BillingActionResult) => {
    if (result.kind === 'opened') onNotice(billingCopy.opened);
    else if (result.kind === 'demo') onNotice(billingCopy.demoAction);
    else if (result.kind === 'disabled') onNotice(billingCopy.purchaseDisabled);
    else onNotice(billingErrorMessage(billingCopy, result.code));
  };

  const submit = async () => {
    if (!checkoutAvailable || (!current && !selectedPlan)) return;
    setActionBusy(true);
    try {
      presentResult(
        current
          ? await onPortal('update')
          : await onCheckout(selectedPlan!.code),
      );
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <AppSafeArea>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="subscriptions-screen"
      >
        <ScreenTitle title={cloudCopy.name} subtitle={accountCopy.subtitle} />

        <Surface style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={styles.heroIcon}>
              <Ionicons name="cloud" size={31} color="#FFFFFF" />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>{cloudCopy.eyebrow}</Text>
              <Text style={styles.heroTitle}>{cloudCopy.name}</Text>
            </View>
          </View>
          <Text style={styles.heroTagline}>{cloudCopy.tagline}</Text>
          <Text style={styles.heroBody}>{cloudCopy.accountBody}</Text>
          <SubscriptionBadge subscription={subscription} loading={loading} />
        </Surface>

        <CloudPlusFeatures compact />

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{accountCopy.membership}</Text>
        </View>
        <Surface style={styles.membershipCard}>
          <View style={[styles.membershipIcon, current && styles.membershipIconActive]}>
            <Ionicons
              name={current ? 'shield-checkmark' : 'shield-outline'}
              size={25}
              color={current ? '#FFFFFF' : colors.blue}
            />
          </View>
          <View style={styles.membershipCopy}>
            <Text style={styles.membershipTitle}>
              {subscriptionStatusLabel(billingCopy, subscription)}
            </Text>
            <Text style={styles.membershipBody}>
              {current ? accountCopy.activeBody : accountCopy.inactiveBody}
            </Text>
            {currentPlanName ? (
              <Text style={styles.membershipMeta}>
                {periodEnd
                  ? `${currentPlanName} · ${subscription?.cancelAtPeriodEnd ? billingCopy.endsOn : billingCopy.renewsOn} ${periodEnd}`
                  : currentPlanName}
              </Text>
            ) : null}
          </View>
        </Surface>

        {mode === 'demo' ? (
          <View style={styles.demoBanner} testID="billing-demo-banner">
            <Ionicons name="flask-outline" size={21} color="#704600" />
            <View style={styles.demoCopy}>
              <Text style={styles.demoTitle}>{billingCopy.demoTitle}</Text>
              <Text style={styles.demoBody}>{billingCopy.demoBody}</Text>
            </View>
          </View>
        ) : null}

        {error ? (
          <Surface style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={26} color={colors.danger} />
            <Text style={styles.errorText}>{billingErrorMessage(billingCopy, error)}</Text>
            <OutlineButton label={billingCopy.retry} onPress={() => void onRetry()} />
          </Surface>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{accountCopy.plans}</Text>
          <Text style={styles.sectionBody}>{accountCopy.choosePlan}</Text>
        </View>

        {loading && !subscription ? (
          <Surface style={styles.loadingCard}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.loadingText}>{billingCopy.loading}</Text>
          </Surface>
        ) : plans.length ? (
          <View style={styles.planStack}>
            {plans.map((plan) => {
              const selected = plan.code === selectedPlanCode;
              const price = formatBillingMoney(plan.amountMinor, plan.currency, language);
              const interval = billingIntervalLabel(
                plan.interval,
                billingCopy.month,
                billingCopy.year,
                plan.intervalCount,
              );
              return (
                <Pressable
                  key={plan.code}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: current }}
                  disabled={current}
                  onPress={() => setSelectedPlanCode(plan.code)}
                  style={({ pressed }) => [
                    styles.planCard,
                    selected && styles.planCardSelected,
                    current && styles.planCardDisabled,
                    pressed && styles.pressed,
                  ]}
                  testID={`billing-plan-${plan.code}`}
                >
                  <View style={[styles.radio, selected && styles.radioSelected]}>
                    {selected ? <View style={styles.radioDot} /> : null}
                  </View>
                  <View style={styles.planCopy}>
                    <Text style={styles.planName}>
                      {localizedBillingPlanName(plan.code, plan.name, language)}
                    </Text>
                    <Text style={styles.planPrice}>
                      {price && interval ? `${price} / ${interval}` : billingCopy.priceAtCheckout}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Surface style={styles.noPlansCard}>
            <Ionicons name="hourglass-outline" size={24} color={colors.muted} />
            <Text style={styles.noPlansText}>{billingCopy.noPlans}</Text>
          </Surface>
        )}

        {(current || selectedPlan) && checkoutAvailable ? (
          <PrimaryButton
            label={actionBusy ? billingCopy.loading : current ? accountCopy.manage : accountCopy.subscribe}
            icon={current ? 'open-outline' : 'card-outline'}
            onPress={() => void submit()}
            disabled={actionBusy || loading || !purchasesEnabled}
            testID="subscription-primary-action"
          />
        ) : null}

        {!purchasesEnabled && checkoutAvailable ? (
          <View style={styles.policyNotice} testID="external-purchase-disabled">
            <Ionicons name="information-circle-outline" size={22} color={colors.mutedDark} />
            <Text style={styles.policyText}>{billingCopy.purchaseDisabled}</Text>
          </View>
        ) : null}

        <View style={styles.secureNotice}>
          <Ionicons name="shield-checkmark-outline" size={23} color={colors.blue} />
          <Text style={styles.secureText}>{billingCopy.secureNotice}</Text>
        </View>
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 36, gap: 17 },
  hero: { padding: 19, gap: 10, backgroundColor: colors.navy, borderColor: colors.navy },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroIcon: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCopy: { flex: 1, gap: 2 },
  heroEyebrow: { color: '#AFC7FF', fontSize: 10, fontWeight: '900', letterSpacing: 1.1 },
  heroTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '900' },
  heroTagline: { color: '#FFFFFF', fontSize: 18, lineHeight: 23, fontWeight: '800', marginTop: 4 },
  heroBody: { color: '#D9E5FF', fontSize: 13, lineHeight: 19 },
  sectionHeader: { gap: 5, marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 21, fontWeight: '800' },
  sectionBody: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  membershipCard: { padding: 17, flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
  membershipIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.bluePale,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membershipIconActive: { backgroundColor: colors.blue },
  membershipCopy: { flex: 1, gap: 5 },
  membershipTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  membershipBody: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  membershipMeta: { color: colors.blueDark, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  demoBanner: {
    borderRadius: radii.medium,
    backgroundColor: '#FFF5D9',
    borderWidth: 1,
    borderColor: '#F5D58A',
    padding: 15,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  demoCopy: { flex: 1, gap: 4 },
  demoTitle: { color: '#5F3D00', fontSize: 15, fontWeight: '800' },
  demoBody: { color: '#745516', fontSize: 13, lineHeight: 19 },
  errorCard: { padding: 18, gap: 12 },
  errorText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  loadingCard: { minHeight: 112, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { color: colors.muted, fontSize: 14 },
  planStack: { gap: 10 },
  planCard: {
    minHeight: 78,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.medium,
    backgroundColor: colors.surface,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  planCardSelected: { borderColor: colors.blue, backgroundColor: '#F5F8FF' },
  planCardDisabled: { opacity: 0.76 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  planCopy: { flex: 1, gap: 4 },
  planName: { color: colors.text, fontSize: 16, fontWeight: '800' },
  planPrice: { color: colors.blueDark, fontSize: 13, fontWeight: '700' },
  noPlansCard: { padding: 20, alignItems: 'center', gap: 9 },
  noPlansText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  policyNotice: {
    borderRadius: 14,
    backgroundColor: '#F0F2F6',
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  policyText: { color: colors.mutedDark, flex: 1, fontSize: 13, lineHeight: 19 },
  secureNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 6 },
  secureText: { color: colors.muted, flex: 1, fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
