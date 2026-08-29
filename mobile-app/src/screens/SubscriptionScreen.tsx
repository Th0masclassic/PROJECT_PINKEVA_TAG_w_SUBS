import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  billingErrorMessage,
  interpolateBillingCopy,
  subscriptionStatusLabel,
  useBillingCopy,
} from '../billing/copy';
import { CloudPlusFeatures } from '../billing/CloudPlusFeatures';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import {
  billingIntervalLabel,
  formatBillingDate,
  formatBillingMoney,
  localizedBillingPlanName,
} from '../billing/format';
import { SubscriptionBadge } from '../billing/SubscriptionBadge';
import {
  canStartCheckout,
  isCurrentSubscription,
  type BillingActionResult,
  type BillingErrorCode,
  type BillingMode,
  type BillingPortalAction,
  type BillingPlan,
  type DeviceSubscription,
} from '../billing/types';
import {
  AppSafeArea,
  BackHeader,
  OutlineButton,
  PrimaryButton,
  Surface,
} from '../components';
import { useI18n } from '../i18n';
import type { Tracker } from '../model';
import { colors, radii } from '../theme';

const EMPTY_PLANS: BillingPlan[] = [];

export function SubscriptionScreen({
  tracker,
  subscription,
  loading,
  error,
  mode,
  purchasesEnabled,
  onBack,
  onRetry,
  onCheckout,
  onPortal,
  onNotice,
}: {
  tracker: Tracker;
  subscription?: DeviceSubscription;
  loading: boolean;
  error?: BillingErrorCode;
  mode: BillingMode;
  purchasesEnabled: boolean;
  onBack: () => void;
  onRetry: () => Promise<void>;
  onCheckout: (planCode: string) => Promise<BillingActionResult>;
  onPortal: (action: BillingPortalAction) => Promise<BillingActionResult>;
  onNotice: (message: string) => void;
}) {
  const { language } = useI18n();
  const copy = useBillingCopy();
  const cloudCopy = useCloudPlusCopy();
  const [selectedPlanCode, setSelectedPlanCode] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'primary' | 'cancel' | null>(null);
  const [cancelVisible, setCancelVisible] = useState(false);
  const plans = subscription?.availablePlans ?? EMPTY_PLANS;

  useEffect(() => {
    const preferred =
      plans.find((plan) => plan.code === subscription?.planCode)?.code ?? plans[0]?.code ?? null;
    setSelectedPlanCode((current) =>
      current && plans.some((plan) => plan.code === current) ? current : preferred,
    );
  }, [plans, subscription?.planCode]);

  const current = subscription ? isCurrentSubscription(subscription) : false;
  const canCheckout = subscription ? canStartCheckout(subscription) : false;
  const primaryLabel = subscription?.cancelAtPeriodEnd
    ? purchasesEnabled
      ? copy.renew
      : copy.manage
    : current
      ? copy.manage
      : copy.subscribe;
  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.code === selectedPlanCode),
    [plans, selectedPlanCode],
  );

  const presentResult = (result: BillingActionResult) => {
    if (result.kind === 'opened') onNotice(copy.opened);
    else if (result.kind === 'demo') onNotice(copy.demoAction);
    else if (result.kind === 'disabled') onNotice(copy.purchaseDisabled);
    else onNotice(billingErrorMessage(copy, result.code));
  };

  const submit = async () => {
    if (!subscription) return;
    setActionBusy('primary');
    try {
      const result = canCheckout
        ? selectedPlan
          ? await onCheckout(selectedPlan.code)
          : { kind: 'error' as const, code: 'invalid_response' as const }
        : await onPortal('update');
      presentResult(result);
    } finally {
      setActionBusy(null);
    }
  };

  const confirmCancellation = async () => {
    setCancelVisible(false);
    setActionBusy('cancel');
    try {
      presentResult(await onPortal('cancel'));
    } finally {
      setActionBusy(null);
    }
  };

  const periodStart = formatBillingDate(subscription?.currentPeriodStart ?? null, language);
  const periodEnd = formatBillingDate(subscription?.currentPeriodEnd ?? null, language);
  const currentPrice = formatBillingMoney(
    subscription?.amountMinor ?? null,
    subscription?.currency ?? null,
    language,
  );
  const currentInterval = billingIntervalLabel(
    subscription?.interval ?? null,
    copy.month,
    copy.year,
    subscription?.intervalCount ?? 1,
  );

  return (
    <AppSafeArea>
      <BackHeader title={copy.title} onBack={onBack} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="subscription-screen"
      >
        <Text style={styles.subtitle}>{copy.subtitle}</Text>

        <Surface style={styles.cloudHero}>
          <View style={styles.heroTop}>
            <View style={styles.cloudIcon}>
              <Ionicons name="cloud" size={31} color="#FFFFFF" />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.cloudEyebrow}>{cloudCopy.eyebrow}</Text>
              <Text style={styles.cloudName}>{cloudCopy.name}</Text>
            </View>
          </View>
          <Text style={styles.cloudTagline}>{cloudCopy.tagline}</Text>
          <Text style={styles.cloudBody}>{cloudCopy.accountBody}</Text>
          <View style={styles.heroBadge}>
            <SubscriptionBadge subscription={subscription} loading={loading} />
          </View>
        </Surface>

        <CloudPlusFeatures />

        {mode === 'demo' ? (
          <View style={styles.demoBanner} testID="billing-demo-banner">
            <View style={styles.demoIcon}>
              <Ionicons name="flask-outline" size={21} color="#704600" />
            </View>
            <View style={styles.demoCopy}>
              <View style={styles.demoTitleRow}>
                <Text style={styles.demoTitle}>{copy.demoTitle}</Text>
                <Text style={styles.demoBadge}>{copy.demoBadge}</Text>
              </View>
              <Text style={styles.demoBody}>{copy.demoBody}</Text>
            </View>
          </View>
        ) : null}

        {error ? (
          <Surface style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={26} color={colors.danger} />
            <Text style={styles.errorText}>{billingErrorMessage(copy, error)}</Text>
            <OutlineButton label={copy.retry} onPress={() => void onRetry()} />
          </Surface>
        ) : null}

        {loading && !subscription ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.loadingText}>{copy.loading}</Text>
          </View>
        ) : subscription ? (
          <>
            <Text style={styles.sectionTitle}>{copy.status}</Text>
            <Surface style={styles.detailsCard}>
              <DetailRow
                label={copy.status}
                value={subscriptionStatusLabel(copy, subscription)}
                isLast={!current}
              />
              {current ? (
                <>
                  <DetailRow
                    label={copy.currentPlan}
                    value={
                      subscription.planCode && subscription.planName
                        ? localizedBillingPlanName(
                            subscription.planCode,
                            subscription.planName,
                            language,
                          )
                        : '—'
                    }
                  />
                  <DetailRow
                    label={copy.billingPeriod}
                    value={
                      currentPrice && currentInterval
                        ? `${currentPrice} / ${currentInterval}`
                        : '—'
                    }
                  />
                  <DetailRow
                    label={copy.currentPeriod}
                    value={periodStart && periodEnd ? `${periodStart} – ${periodEnd}` : '—'}
                  />
                  <DetailRow
                    label={subscription.cancelAtPeriodEnd ? copy.endsOn : copy.renewsOn}
                    value={periodEnd ?? '—'}
                  />
                  <DetailRow
                    label={copy.autoRenew}
                    value={subscription.cancelAtPeriodEnd ? copy.autoRenewOff : copy.autoRenewOn}
                    warning={subscription.cancelAtPeriodEnd}
                    isLast
                  />
                </>
              ) : null}
            </Surface>

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{copy.plans}</Text>
              {!current ? <Text style={styles.sectionBody}>{copy.choosePlan}</Text> : null}
            </View>
            {plans.length ? (
              <View style={styles.planStack}>
                {plans.map((plan) => (
                  <PlanOption
                    key={plan.code}
                    plan={plan}
                    selected={plan.code === selectedPlanCode}
                    disabled={current}
                    onPress={() => setSelectedPlanCode(plan.code)}
                  />
                ))}
              </View>
            ) : (
              <Surface style={styles.noPlansCard}>
                <Ionicons name="hourglass-outline" size={24} color={colors.muted} />
                <Text style={styles.noPlansText}>{copy.noPlans}</Text>
              </Surface>
            )}

            {!purchasesEnabled ? (
              <View style={styles.policyNotice} testID="external-purchase-disabled">
                <Ionicons name="information-circle-outline" size={22} color={colors.mutedDark} />
                <Text style={styles.policyText}>{copy.purchaseDisabled}</Text>
              </View>
            ) : null}

            <PrimaryButton
              label={actionBusy === 'primary' ? copy.loading : primaryLabel}
              icon={current ? 'open-outline' : 'card-outline'}
              onPress={() => void submit()}
              disabled={
                actionBusy !== null ||
                loading ||
                (current && !purchasesEnabled) ||
                (canCheckout && (!selectedPlan || !purchasesEnabled))
              }
              testID="subscription-primary-action"
            />
            {current && !subscription.cancelAtPeriodEnd ? (
              <Pressable
                accessibilityRole="button"
                disabled={actionBusy !== null}
                onPress={() => setCancelVisible(true)}
                style={({ pressed }) => [
                  styles.cancelAction,
                  actionBusy !== null && styles.cancelActionDisabled,
                  pressed && styles.pressed,
                ]}
                testID="subscription-cancel-action"
              >
                <Ionicons name="close-circle-outline" size={21} color={colors.danger} />
                <Text style={styles.cancelActionText}>
                  {actionBusy === 'cancel' ? copy.loading : copy.cancel}
                </Text>
              </Pressable>
            ) : null}
            <View style={styles.secureNotice}>
              <Ionicons name="shield-checkmark-outline" size={23} color={colors.blue} />
              <Text style={styles.secureText}>{copy.secureNotice}</Text>
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal
        transparent
        visible={cancelVisible}
        animationType="fade"
        onRequestClose={() => setCancelVisible(false)}
      >
        <View style={styles.modalScrim}>
          <Pressable onPress={() => setCancelVisible(false)} style={StyleSheet.absoluteFill} />
          <Surface style={styles.cancelModal}>
            <View style={styles.cancelModalIcon}>
              <Ionicons name="alert-outline" size={29} color={colors.danger} />
            </View>
            <Text style={styles.cancelModalTitle}>{copy.cancelConfirmTitle}</Text>
            <Text style={styles.cancelModalBody}>
              {interpolateBillingCopy(copy.cancelConfirmBody, { name: tracker.name })}
            </Text>
            <OutlineButton
              label={copy.keepSubscription}
              onPress={() => setCancelVisible(false)}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void confirmCancellation()}
              style={({ pressed }) => [styles.confirmCancel, pressed && styles.pressed]}
              testID="subscription-confirm-cancel"
            >
              <Text style={styles.confirmCancelText}>{copy.confirmCancel}</Text>
            </Pressable>
          </Surface>
        </View>
      </Modal>
    </AppSafeArea>
  );

  function PlanOption({
    plan,
    selected,
    disabled,
    onPress,
  }: {
    plan: BillingPlan;
    selected: boolean;
    disabled: boolean;
    onPress: () => void;
  }) {
    const price = formatBillingMoney(plan.amountMinor, plan.currency, language);
    const interval = billingIntervalLabel(
      plan.interval,
      copy.month,
      copy.year,
      plan.intervalCount,
    );
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected, disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.planCard,
          selected && styles.planCardSelected,
          disabled && styles.planCardDisabled,
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
        </View>
        <Text style={styles.planPrice}>
          {price && interval ? `${price} / ${interval}` : copy.priceAtCheckout}
        </Text>
      </Pressable>
    );
  }
}

function DetailRow({
  label,
  value,
  warning = false,
  isLast = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.detailRow, !isLast && styles.detailDivider]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, warning && styles.detailWarning]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 38, gap: 16 },
  subtitle: { color: colors.muted, fontSize: 16, marginTop: -8, marginBottom: 2, textAlign: 'center' },
  cloudHero: { padding: 19, gap: 10, backgroundColor: colors.navy, borderColor: colors.navy },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  cloudIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  heroCopy: { flex: 1, gap: 2 },
  heroBadge: { alignItems: 'flex-start', marginTop: 2 },
  cloudEyebrow: { color: '#AFC7FF', fontSize: 10, fontWeight: '900', letterSpacing: 1.1 },
  cloudName: { color: '#FFFFFF', fontSize: 22, fontWeight: '900' },
  cloudTagline: { color: '#FFFFFF', fontSize: 18, lineHeight: 23, fontWeight: '800', marginTop: 4 },
  cloudBody: { color: '#D9E5FF', fontSize: 13, lineHeight: 19 },
  demoBanner: { borderRadius: radii.medium, backgroundColor: '#FFF5D9', borderWidth: 1, borderColor: '#F5D58A', padding: 15, flexDirection: 'row', gap: 12 },
  demoIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#FFE6A7', alignItems: 'center', justifyContent: 'center' },
  demoCopy: { flex: 1, gap: 5 },
  demoTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  demoTitle: { color: '#5F3D00', fontSize: 16, fontWeight: '800' },
  demoBadge: { color: '#704600', fontSize: 10, fontWeight: '900', letterSpacing: 1, backgroundColor: '#FFE291', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  demoBody: { color: '#745516', fontSize: 13, lineHeight: 19 },
  errorCard: { padding: 18, gap: 12 },
  errorText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  loadingWrap: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.muted, fontSize: 15 },
  sectionHeader: { gap: 5, marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  sectionBody: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  detailsCard: { paddingHorizontal: 17 },
  detailRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 16 },
  detailDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  detailLabel: { color: colors.mutedDark, fontSize: 14, flex: 1 },
  detailValue: { color: colors.text, fontSize: 14, fontWeight: '700', textAlign: 'right', flex: 1.25 },
  detailWarning: { color: '#9A5A00' },
  planStack: { gap: 10 },
  planCard: { minHeight: 82, borderWidth: 1.5, borderColor: colors.border, borderRadius: radii.medium, backgroundColor: colors.surface, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  planCardSelected: { borderColor: colors.blue, backgroundColor: '#F5F8FF' },
  planCardDisabled: { opacity: 0.78 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  planCopy: { flex: 1, gap: 3 },
  planName: { color: colors.text, fontSize: 16, fontWeight: '800' },
  planPrice: { color: colors.blueDark, fontSize: 14, fontWeight: '800', maxWidth: 122, textAlign: 'right' },
  noPlansCard: { padding: 20, alignItems: 'center', gap: 9 },
  noPlansText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  policyNotice: { borderRadius: 14, backgroundColor: '#F0F2F6', padding: 13, flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  policyText: { color: colors.mutedDark, flex: 1, fontSize: 13, lineHeight: 19 },
  secureNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 6, marginTop: 2 },
  secureText: { color: colors.muted, flex: 1, fontSize: 12, lineHeight: 18 },
  cancelAction: { minHeight: 54, borderWidth: 1.5, borderColor: '#FFC8CA', borderRadius: 15, backgroundColor: '#FFF8F8', paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  cancelActionDisabled: { opacity: 0.5 },
  cancelActionText: { color: colors.danger, fontSize: 16, fontWeight: '800' },
  modalScrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.52)', justifyContent: 'center', padding: 24 },
  cancelModal: { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, gap: 14 },
  cancelModalIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  cancelModalTitle: { color: colors.text, fontSize: 24, fontWeight: '800' },
  cancelModalBody: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  confirmCancel: { minHeight: 54, borderRadius: 15, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  confirmCancelText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
