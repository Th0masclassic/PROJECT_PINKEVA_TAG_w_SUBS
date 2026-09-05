import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  interpolateAccountBillingCopy,
  useAccountBillingCopy,
} from '../billing/accountCopy';
import { CloudPlusFeatures } from '../billing/CloudPlusFeatures';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import {
  billingErrorMessage,
  subscriptionStatusLabel,
  useBillingCopy,
} from '../billing/copy';
import {
  billingDurationLabel,
  formatBillingDate,
  formatBillingMoney,
  formatMonthlyEquivalent,
  localizedBillingPlanName,
  planSavingsPercent,
  recommendedBillingPlanCode,
} from '../billing/format';
import { SubscriptionBadge } from '../billing/SubscriptionBadge';
import {
  hasActiveSubscriptionAccess,
  isCurrentSubscription,
  type BillingActionResult,
  type BillingErrorCode,
  type BillingMode,
  type BillingPlan,
  type BillingPortalAction,
  type AccountSubscription,
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
  subscription?: AccountSubscription;
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
  const { language, t } = useI18n();
  const accountCopy = useAccountBillingCopy();
  const billingCopy = useBillingCopy();
  const cloudCopy = useCloudPlusCopy();
  const plans = useMemo(
    () => [...(subscription?.availablePlans ?? EMPTY_PLANS)].sort((left, right) => left.durationMonths - right.durationMonths),
    [subscription?.availablePlans],
  );
  const manageable = subscription ? isCurrentSubscription(subscription) : false;
  const activeAccess = subscription ? hasActiveSubscriptionAccess(subscription) : false;
  const monthlyPlan = plans.find((plan) => plan.durationMonths === 1);
  const recommendedPlanCode = recommendedBillingPlanCode(plans);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [manageVisible, setManageVisible] = useState(false);
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

  const submitCheckout = async (plan: BillingPlan) => {
    if (!checkoutAvailable || manageable) return;
    setActionBusy(plan.code);
    try {
      presentResult(await onCheckout(plan.code));
    } finally {
      setActionBusy(null);
    }
  };

  const submitPortal = async (action: BillingPortalAction) => {
    setActionBusy(action);
    try {
      const result = await onPortal(action);
      setManageVisible(false);
      presentResult(result);
    } finally {
      setActionBusy(null);
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
          <View style={[styles.membershipIcon, activeAccess && styles.membershipIconActive]}>
            <Ionicons
              name={activeAccess ? 'shield-checkmark' : 'shield-outline'}
              size={25}
              color={activeAccess ? '#FFFFFF' : colors.blue}
            />
          </View>
          <View style={styles.membershipCopy}>
            <Text style={styles.membershipTitle}>
              {subscriptionStatusLabel(billingCopy, subscription)}
            </Text>
            <Text style={styles.membershipBody}>
              {activeAccess ? accountCopy.activeBody : accountCopy.inactiveBody}
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
              const isCurrent = plan.code === subscription?.planCode && manageable;
              const recommended = plan.code === recommendedPlanCode;
              const price = formatBillingMoney(plan.amountMinor, plan.currency, language);
              const interval = billingDurationLabel(plan.durationMonths, language);
              const monthlyEquivalent = formatMonthlyEquivalent(plan, language);
              const savings = planSavingsPercent(plan, monthlyPlan);
              return (
                <View
                  key={plan.code}
                  accessibilityLabel={localizedBillingPlanName(plan.code, plan.name, language)}
                  style={[
                    styles.planCard,
                    (recommended || isCurrent) && styles.planCardSelected,
                  ]}
                  testID={`billing-plan-${plan.code}`}
                >
                  <View style={styles.planHeader}>
                    <View style={styles.planCopy}>
                      <Text style={styles.planName}>
                        {localizedBillingPlanName(plan.code, plan.name, language)}
                      </Text>
                      <Text style={styles.planPrice}>
                        {price && interval ? `${price} / ${interval}` : billingCopy.priceAtCheckout}
                      </Text>
                    </View>
                    {isCurrent ? (
                      <View style={styles.currentBadge}><Text style={styles.currentBadgeText}>{accountCopy.currentPlan}</Text></View>
                    ) : recommended ? (
                      <View style={styles.valueBadge}><Text style={styles.valueBadgeText}>{accountCopy.bestValue}</Text></View>
                    ) : null}
                  </View>
                  <View style={styles.planEconomics}>
                    {plan.durationMonths > 1 && monthlyEquivalent ? (
                      <Text style={styles.planEquivalent}>
                        {interpolateAccountBillingCopy(accountCopy.perMonth, { price: monthlyEquivalent })}
                      </Text>
                    ) : null}
                    {savings ? (
                      <Text style={styles.planSavings}>
                        {interpolateAccountBillingCopy(accountCopy.save, { percent: savings })}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.planBenefits}>
                    {[accountCopy.safeZones, accountCopy.history, accountCopy.smartAlerts,
                      ...(plan.durationMonths >= 6 ? [accountCopy.replacement] : [])].map((benefit) => (
                      <View key={benefit} style={styles.planBenefit}>
                        <Ionicons name="checkmark-circle" size={16} color={colors.blue} />
                        <Text style={styles.planBenefitText}>{benefit}</Text>
                      </View>
                    ))}
                  </View>
                  {!manageable && checkoutAvailable ? (
                    <OutlineButton
                      label={actionBusy === plan.code ? billingCopy.loading : accountCopy.subscribe}
                      icon="card-outline"
                      disabled={Boolean(actionBusy) || loading || !purchasesEnabled}
                      onPress={() => void submitCheckout(plan)}
                      testID={`subscribe-${plan.code}`}
                      style={styles.planAction}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : (
          <Surface style={styles.noPlansCard}>
            <Ionicons name="hourglass-outline" size={24} color={colors.muted} />
            <Text style={styles.noPlansText}>{billingCopy.noPlans}</Text>
          </Surface>
        )}

        {manageable && checkoutAvailable ? (
          <PrimaryButton
            label={actionBusy ? billingCopy.loading : accountCopy.manage}
            icon="options-outline"
            onPress={() => setManageVisible(true)}
            disabled={Boolean(actionBusy) || loading}
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

      <Modal
        transparent
        animationType="slide"
        visible={manageVisible}
        onRequestClose={() => setManageVisible(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setManageVisible(false)} />
          <SafeAreaView edges={['bottom']} style={styles.modalSafeArea}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <View style={styles.modalHeaderCopy}>
                  <Text style={styles.modalTitle}>{accountCopy.manageTitle}</Text>
                  <Text style={styles.modalBody}>{accountCopy.manageBody}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                  onPress={() => setManageVisible(false)}
                  style={styles.modalClose}
                >
                  <Ionicons name="close" size={23} color={colors.mutedDark} />
                </Pressable>
              </View>

              <View style={styles.modalCurrent}>
                <Text style={styles.modalLabel}>{billingCopy.currentPlan}</Text>
                <Text style={styles.modalCurrentPlan}>{currentPlanName ?? billingCopy.unavailable}</Text>
                <Text style={styles.modalCurrentMeta}>{subscriptionStatusLabel(billingCopy, subscription)}</Text>
                {periodEnd ? (
                  <Text style={styles.modalCurrentMeta}>
                    {subscription?.cancelAtPeriodEnd ? billingCopy.endsOn : billingCopy.renewsOn} {periodEnd}
                  </Text>
                ) : null}
              </View>

              <ScrollView style={styles.modalPlans} contentContainerStyle={styles.modalPlanList}>
                {plans.map((plan) => (
                  <View key={plan.code} style={[styles.modalPlan, plan.code === subscription?.planCode && styles.modalPlanCurrent]}>
                    <View style={styles.modalPlanCopy}>
                      <Text style={styles.modalPlanName}>{localizedBillingPlanName(plan.code, plan.name, language)}</Text>
                      <Text style={styles.modalPlanPrice}>
                        {formatBillingMoney(plan.amountMinor, plan.currency, language)} / {billingDurationLabel(plan.durationMonths, language)}
                      </Text>
                    </View>
                    {plan.code === subscription?.planCode ? <Ionicons name="checkmark-circle" size={22} color={colors.blue} /> : null}
                  </View>
                ))}
              </ScrollView>

              <PrimaryButton
                label={actionBusy === 'update' ? billingCopy.loading : accountCopy.changePlan}
                icon="swap-horizontal-outline"
                disabled={Boolean(actionBusy)}
                onPress={() => void submitPortal('update')}
                testID="subscription-change-plan"
              />
              {!subscription?.cancelAtPeriodEnd ? (
                <OutlineButton
                  label={actionBusy === 'cancel' ? billingCopy.loading : billingCopy.cancel}
                  icon="close-circle-outline"
                  disabled={Boolean(actionBusy)}
                  onPress={() => void submitPortal('cancel')}
                  testID="subscription-cancel"
                />
              ) : null}
              <Text style={styles.portalNotice}>{accountCopy.portalNotice}</Text>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
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
    minHeight: 156,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.medium,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 11,
  },
  planCardSelected: { borderColor: colors.blue, backgroundColor: '#F5F8FF' },
  planHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  planEconomics: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  planEquivalent: { color: colors.mutedDark, fontSize: 12, fontWeight: '600' },
  planSavings: { color: '#087B49', fontSize: 12, fontWeight: '800' },
  valueBadge: { borderRadius: 9, backgroundColor: colors.blue, paddingHorizontal: 8, paddingVertical: 5 },
  valueBadgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  currentBadge: { borderRadius: 9, backgroundColor: '#DDE9FF', paddingHorizontal: 8, paddingVertical: 5 },
  currentBadgeText: { color: colors.blueDark, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  planBenefits: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6 },
  planBenefit: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  planBenefitText: { color: colors.mutedDark, fontSize: 11, lineHeight: 16 },
  planAction: { marginTop: 2 },
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
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(3,17,45,0.48)' },
  modalSafeArea: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  modalCard: { maxHeight: '88%', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, gap: 14 },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  modalHeaderCopy: { flex: 1, gap: 5 },
  modalTitle: { color: colors.text, fontSize: 23, lineHeight: 28, fontWeight: '900' },
  modalBody: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  modalClose: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F0F3F8', alignItems: 'center', justifyContent: 'center' },
  modalCurrent: { borderRadius: 18, backgroundColor: colors.navy, padding: 16, gap: 4 },
  modalLabel: { color: '#AFC7FF', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  modalCurrentPlan: { color: '#FFFFFF', fontSize: 19, lineHeight: 24, fontWeight: '900' },
  modalCurrentMeta: { color: '#D9E5FF', fontSize: 12, lineHeight: 17 },
  modalPlans: { maxHeight: 230 },
  modalPlanList: { gap: 8 },
  modalPlan: { minHeight: 62, borderRadius: 15, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalPlanCurrent: { borderColor: colors.blue, backgroundColor: '#F5F8FF' },
  modalPlanCopy: { flex: 1, gap: 3 },
  modalPlanName: { color: colors.text, fontSize: 14, fontWeight: '800' },
  modalPlanPrice: { color: colors.mutedDark, fontSize: 11, lineHeight: 16 },
  portalNotice: { color: colors.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', paddingHorizontal: 8 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
