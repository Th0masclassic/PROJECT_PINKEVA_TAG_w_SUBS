import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
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

import { useBillingCopy } from '../billing/copy';
import { useAccountBillingCopy } from '../billing/accountCopy';
import { billingDurationLabel, formatBillingMoney } from '../billing/format';
import { OutlineButton, PrimaryButton } from '../components';
import { useI18n, type TranslationKey } from '../i18n';
import { colors, radii, shadow } from '../theme';
import type { DiscoveredTag } from './radio';
import { tagSetupErrorTranslationKey } from './setup';
import type { TagSetupPhase, TagSetupState } from './useTagSetup';
import type { ProvisioningPlan } from './api';

const progressSteps: ReadonlyArray<{
  phase: TagSetupPhase;
  key: TranslationKey;
}> = [
  { phase: 'connecting', key: 'pairing.stepConnecting' },
  { phase: 'verifying', key: 'pairing.stepVerifying' },
  { phase: 'authorizing', key: 'pairing.stepAuthorizing' },
  { phase: 'installing', key: 'pairing.stepInstalling' },
  { phase: 'associating', key: 'pairing.stepAssociating' },
];

function signalKey(rssi: number | null): TranslationKey {
  if (rssi === null) return 'pairing.signalDetected';
  if (rssi >= -62) return 'pairing.signalStrong';
  if (rssi >= -78) return 'pairing.signalMedium';
  return 'pairing.signalWeak';
}

function CandidateRow({
  tag,
  actionLabel,
  onPress,
}: {
  tag: DiscoveredTag;
  actionLabel: string;
  onPress: () => void;
}) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${tag.serialNumber}, ${t(signalKey(tag.rssi))}`}
      onPress={onPress}
      style={({ pressed }) => [styles.candidate, pressed && styles.pressed]}
      testID={`tag-candidate-${tag.serialNumber}`}
    >
      <View style={styles.candidateIcon}>
        <Ionicons name="bluetooth" size={24} color={colors.blue} />
      </View>
      <View style={styles.candidateCopy}>
        <Text style={styles.candidateName}>{tag.serialNumber}</Text>
        <Text style={styles.candidateSignal}>{t(signalKey(tag.rssi))}</Text>
      </View>
      <View style={styles.connectPill}>
        <Text style={styles.connectText}>{actionLabel}</Text>
        <Ionicons name="chevron-forward" size={17} color={colors.blue} />
      </View>
    </Pressable>
  );
}

function ProgressContent({ state }: { state: TagSetupState }) {
  const { t } = useI18n();
  const steps = progressSteps.map((step) => ({ phase: step.phase, label: t(step.key) }));
  const activeIndex = steps.findIndex((step) => step.phase === state.phase);
  const targetName = state.targetSerialNumber ?? state.selected?.serialNumber ?? t('common.tracker');
  return (
    <View style={styles.centeredContent}>
      <LinearGradient colors={[colors.blueDark, colors.blue]} style={styles.heroIcon}>
        <Ionicons name="bluetooth" size={38} color="#FFFFFF" />
      </LinearGradient>
      <Text style={styles.title}>
        {t('pairing.settingUpTitle')}
      </Text>
      <Text style={styles.body}>
        {t('pairing.settingUpBody', { name: targetName })}
      </Text>
      <View style={styles.progressCard}>
        {steps.map((step, index) => {
          const complete = activeIndex > index;
          const active = activeIndex === index;
          return (
            <View key={step.phase} style={styles.progressRow}>
              <View style={[styles.progressDot, complete && styles.progressDotComplete]}>
                {complete ? (
                  <Ionicons name="checkmark" size={15} color="#FFFFFF" />
                ) : active ? (
                  <ActivityIndicator size="small" color={colors.blue} />
                ) : (
                  <View style={styles.progressDotIdle} />
                )}
              </View>
              <Text style={[styles.progressText, active && styles.progressTextActive]}>
                {step.label}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.keepNear}>{t('pairing.keepNear')}</Text>
    </View>
  );
}

export function TagSetupModal({
  state,
  onSelect,
  onChoosePlan,
  onRetry,
  onClose,
}: {
  state: TagSetupState;
  onSelect: (tag: DiscoveredTag) => void;
  onChoosePlan: (plan: ProvisioningPlan) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { language, t } = useI18n();
  const billingCopy = useBillingCopy();
  const accountBillingCopy = useAccountBillingCopy();
  const visible = state.phase !== 'idle';
  const scanning = state.phase === 'starting' || state.phase === 'scanning';
  const progressing = progressSteps.some((step) => step.phase === state.phase);
  const paymentRequest = state.provisioningRequest;
  const targetName = state.targetSerialNumber ?? state.selected?.serialNumber ?? t('common.tracker');

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.scrim}>
        <SafeAreaView edges={['bottom']} style={styles.sheetSafeArea}>
          <View style={styles.sheet} testID="tag-setup-sheet">
            <View style={styles.handle} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              onPress={onClose}
              style={styles.closeButton}
              testID="tag-setup-close"
            >
              <Ionicons name="close" size={27} color={colors.text} />
            </Pressable>

            {scanning ? (
              <ScrollView
                contentContainerStyle={styles.scanContent}
                showsVerticalScrollIndicator={false}
              >
                <LinearGradient colors={['#72A5FF', colors.blue]} style={styles.heroIcon}>
                  <Ionicons name="bluetooth" size={38} color="#FFFFFF" />
                </LinearGradient>
                <Text style={styles.title}>{t('pairing.scanTitle')}</Text>
                <Text style={styles.body}>{t('pairing.scanBody')}</Text>

                <View style={styles.scanState} accessibilityLiveRegion="polite">
                  <ActivityIndicator color={colors.blue} />
                  <Text style={styles.scanStateText}>{t('pairing.searching')}</Text>
                </View>

                {state.candidates.length ? (
                  <View style={styles.candidateList}>
                    {state.candidates.map((tag) => (
                      <CandidateRow
                        key={tag.peripheralId}
                        tag={tag}
                        actionLabel={t('pairing.connect')}
                        onPress={() => onSelect(tag)}
                      />
                    ))}
                  </View>
                ) : (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyTitle}>
                      {t('pairing.noTagsTitle')}
                    </Text>
                    <Text style={styles.emptyBody}>
                      {t('pairing.noTagsBody')}
                    </Text>
                  </View>
                )}
              </ScrollView>
            ) : progressing ? (
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <ProgressContent state={state} />
                <OutlineButton
                  label={t('common.cancel')}
                  onPress={onClose}
                  style={styles.fullButton}
                />
              </ScrollView>
            ) : state.phase === 'payment' || state.phase === 'waiting_payment' ? (
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <View style={[styles.heroIcon, styles.paymentIcon]}>
                  <Ionicons name="card-outline" size={38} color="#FFFFFF" />
                </View>
                <Text style={styles.title}>{accountBillingCopy.plans}</Text>
                <Text style={styles.body}>
                  {state.phase === 'waiting_payment'
                    ? billingCopy.loading
                    : accountBillingCopy.choosePlan}
                </Text>
                {paymentRequest ? (
                  <Text style={styles.requestId}>
                    Request {paymentRequest.request_id}
                  </Text>
                ) : null}
                {state.phase === 'waiting_payment' ? (
                  <View style={styles.scanState}>
                    <ActivityIndicator color={colors.blue} />
                    <Text style={styles.scanStateText}>
                      {billingCopy.opening ?? billingCopy.loading}
                    </Text>
                  </View>
                ) : paymentRequest?.available_plans.length ? (
                  <View style={styles.planStack}>
                    {paymentRequest.available_plans.map((plan) => (
                      <Pressable
                        key={plan.code}
                        accessibilityRole="button"
                        onPress={() => onChoosePlan(plan)}
                        style={({ pressed }) => [styles.planOption, pressed && styles.pressed]}
                      >
                        <View style={styles.planCopy}>
                          <Text style={styles.planName}>{plan.name}</Text>
                          <Text style={styles.planTerms}>
                            {formatBillingMoney(plan.amount_minor, plan.currency, language)}{' '}
                            /{' '}
                            {billingDurationLabel(plan.duration_months, language)}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={23} color={colors.blue} />
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.body}>{billingCopy.noPlans}</Text>
                )}
                <Text style={styles.secureText}>{billingCopy.secureNotice}</Text>
                <OutlineButton
                  label={t('common.cancel')}
                  onPress={onClose}
                  style={styles.fullButton}
                />
              </ScrollView>
            ) : state.phase === 'success' ? (
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <View style={[styles.heroIcon, styles.successIcon]}>
                  <Ionicons name="checkmark" size={42} color="#FFFFFF" />
                </View>
                <Text style={styles.title}>{t('pairing.setupCompleteTitle')}</Text>
                <Text style={styles.body}>
                  {t('pairing.setupCompleteBody', {
                    name: state.claim?.serial_number ?? state.selected?.serialNumber ?? '',
                  })}
                </Text>
                <PrimaryButton
                  label={t('common.done')}
                  onPress={onClose}
                  style={styles.fullButton}
                  testID="tag-setup-done"
                />
              </ScrollView>
            ) : (
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <View style={[styles.heroIcon, styles.errorIcon]}>
                  <Ionicons name="alert-circle-outline" size={42} color={colors.danger} />
                </View>
                <Text style={styles.title}>{t('pairing.setupErrorTitle')}</Text>
                <Text style={styles.body}>
                  {t(
                    tagSetupErrorTranslationKey(state.error ?? 'unavailable'),
                  )}
                </Text>
                {state.selected ? (
                  <View style={styles.selectedSerial}>
                    <Ionicons name="pricetag-outline" size={20} color={colors.mutedDark} />
                    <Text style={styles.selectedSerialText}>{state.selected.serialNumber}</Text>
                  </View>
                ) : null}
                <PrimaryButton
                  label={t('pairing.retry')}
                  icon="refresh"
                  onPress={onRetry}
                  style={styles.fullButton}
                  testID="tag-setup-retry"
                />
                <OutlineButton
                  label={t('common.cancel')}
                  onPress={onClose}
                  style={styles.fullButton}
                />
              </ScrollView>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.52)', justifyContent: 'flex-end' },
  sheetSafeArea: {
    height: '88%',
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  sheet: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingTop: 38,
  },
  handle: {
    position: 'absolute',
    top: 14,
    alignSelf: 'center',
    width: 46,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#D0D5E0',
  },
  closeButton: {
    position: 'absolute',
    top: 22,
    right: 20,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#F6F7FA',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  scanContent: { paddingHorizontal: 24, paddingTop: 30, paddingBottom: 30, alignItems: 'center' },
  sheetContent: { paddingHorizontal: 26, paddingTop: 34, paddingBottom: 28, alignItems: 'center' },
  centeredContent: { alignItems: 'center', width: '100%' },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  successIcon: { backgroundColor: colors.blue },
  paymentIcon: { backgroundColor: colors.blue },
  errorIcon: { backgroundColor: '#FFF0F1', shadowOpacity: 0 },
  title: { color: colors.text, fontSize: 29, fontWeight: '800', textAlign: 'center', marginTop: 20 },
  body: { color: colors.mutedDark, fontSize: 17, lineHeight: 25, textAlign: 'center', marginTop: 10 },
  requestId: { color: colors.muted, fontSize: 12, marginTop: 12 },
  scanState: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24 },
  scanStateText: { color: colors.blue, fontSize: 15, fontWeight: '700' },
  candidateList: { width: '100%', gap: 12, marginTop: 24 },
  candidate: {
    minHeight: 82,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.medium,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 12,
    ...shadow,
  },
  candidateIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  candidateCopy: { flex: 1, gap: 4 },
  candidateName: { color: colors.text, fontSize: 16, fontWeight: '800' },
  candidateSignal: { color: colors.mutedDark, fontSize: 13 },
  connectPill: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  connectText: { color: colors.blue, fontSize: 14, fontWeight: '800' },
  emptyState: { width: '100%', marginTop: 28, borderRadius: radii.medium, backgroundColor: '#F6F8FC', padding: 22, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  emptyBody: { color: colors.mutedDark, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 7 },
  progressCard: { width: '100%', marginTop: 28, borderRadius: radii.large, backgroundColor: '#F6F8FC', padding: 18, gap: 16 },
  progressRow: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 13 },
  progressDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: '#C9D3E6', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  progressDotComplete: { backgroundColor: colors.blue, borderColor: colors.blue },
  progressDotIdle: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#C9D3E6' },
  progressText: { color: colors.mutedDark, fontSize: 15, fontWeight: '600' },
  progressTextActive: { color: colors.text, fontWeight: '800' },
  keepNear: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 18 },
  planStack: { width: '100%', gap: 10, marginTop: 22 },
  planOption: {
    minHeight: 76,
    borderRadius: radii.medium,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
  },
  planCopy: { flex: 1, gap: 5 },
  planName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  planTerms: { color: colors.mutedDark, fontSize: 14 },
  secureText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 18 },
  selectedSerial: { marginTop: 20, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F6F8FC', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  selectedSerialText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  fullButton: { width: '100%', marginTop: 18 },
  pressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
});
