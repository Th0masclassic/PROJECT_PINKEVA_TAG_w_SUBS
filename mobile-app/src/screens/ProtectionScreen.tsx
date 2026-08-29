import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CloudPlusFeatures } from '../billing/CloudPlusFeatures';
import {
  AppSafeArea,
  BackHeader,
  OutlineButton,
  PrimaryButton,
  Surface,
} from '../components';
import { useI18n, type Language } from '../i18n';
import type { Tracker } from '../model';
import {
  PremiumApiError,
  SAFE_ZONE_LIMIT,
  SAFE_ZONE_MAX_RADIUS_METERS,
  SAFE_ZONE_MIN_RADIUS_METERS,
  type DeviceSafeZone,
  type PremiumFeatureAccess,
  type PremiumTrackerOverview,
  type SafeZoneInput,
} from '../premium/api';
import {
  interpolateProtectionCopy,
  useProtectionCopy,
  type ProtectionCopy,
} from '../premium/copy';
import { useSafeZones } from '../premium/useSafeZones';
import type { ProvisioningApiConfig } from '../provisioning/api';
import { colors, radii, shadow } from '../theme';

type ZoneDraft = {
  id?: string;
  name: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
};

export function ProtectionScreen({
  tracker,
  features,
  overview,
  premiumLoading,
  premiumError,
  ownerKey,
  apiConfig,
  getAccessToken,
  demoPreviewEnabled,
  onBack,
  onOpenSubscription,
  onRefreshPremium,
  onNotice,
}: {
  tracker: Tracker;
  features?: PremiumFeatureAccess;
  overview?: PremiumTrackerOverview;
  premiumLoading: boolean;
  premiumError?: string;
  ownerKey: string;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  demoPreviewEnabled: boolean;
  onBack: () => void;
  onOpenSubscription: () => void;
  onRefreshPremium: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const { language, t } = useI18n();
  const copy = useProtectionCopy();
  const active = Boolean(features?.subscriptionActive);
  const safeZonesAvailable = Boolean(active && features?.safeZones);
  const safeZoneState = useSafeZones({
    ownerKey,
    deviceId: tracker.id,
    enabled: safeZonesAvailable,
    apiConfig,
    getAccessToken,
    demoPreviewEnabled,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<ZoneDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshPremium();
      if (safeZonesAvailable) await safeZoneState.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const openNewZone = () => {
    setDraftError(null);
    setDraft({
      name: '',
      latitude: numberInputValue(tracker.latitude),
      longitude: numberInputValue(tracker.longitude),
      radiusMeters: String(SAFE_ZONE_MIN_RADIUS_METERS),
    });
  };

  const openZone = (zone: DeviceSafeZone) => {
    setDraftError(null);
    setDraft({
      id: zone.id,
      name: zone.name,
      latitude: String(zone.latitude),
      longitude: String(zone.longitude),
      radiusMeters: String(zone.radiusMeters),
    });
  };

  const saveZone = async () => {
    if (!draft) return;
    const parsed = parseZoneDraft(draft, copy);
    if (typeof parsed === 'string') {
      setDraftError(parsed);
      return;
    }
    setDraftError(null);
    try {
      if (draft.id) {
        await safeZoneState.update(draft.id, parsed);
        onNotice(copy.zoneUpdated);
      } else {
        await safeZoneState.create(parsed);
        onNotice(copy.zoneCreated);
      }
      setDraft(null);
      await onRefreshPremium();
    } catch (error) {
      setDraftError(
        error instanceof PremiumApiError && error.code === 'SAFE_ZONE_LIMIT_REACHED'
          ? copy.limitError
          : copy.saveError,
      );
    }
  };

  const confirmDelete = (zone: DeviceSafeZone) => {
    Alert.alert(
      copy.deleteTitle,
      interpolateProtectionCopy(copy.deleteBody, { name: zone.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: copy.deleteAction,
          style: 'destructive',
          onPress: () => {
            void safeZoneState.remove(zone.id).then(async () => {
              onNotice(copy.zoneDeleted);
              await onRefreshPremium();
            }).catch(() => onNotice(copy.saveError));
          },
        },
      ],
    );
  };

  return (
    <AppSafeArea>
      <BackHeader title={copy.title} onBack={onBack} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        showsVerticalScrollIndicator={false}
        testID="protection-screen"
      >
        {premiumLoading && !features ? (
          <Surface style={styles.centerCard}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.centerText}>{copy.loading}</Text>
          </Surface>
        ) : !features && premiumError ? (
          <Surface style={styles.errorCard}>
            <Ionicons name="cloud-offline-outline" size={31} color={colors.danger} />
            <Text style={styles.errorText}>{copy.loadError}</Text>
            <OutlineButton label={copy.retry} onPress={() => void refresh()} />
          </Surface>
        ) : active ? (
          <>
            <Surface style={styles.activeHero}>
              <View style={styles.heroIcon}>
                <Ionicons name="shield-checkmark" size={35} color="#FFFFFF" />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>PINKEVA CLOUD +</Text>
                <Text style={styles.heroTitle}>{copy.activeTitle}</Text>
                <Text style={styles.heroBody}>{copy.activeBody}</Text>
              </View>
            </Surface>

            <Text style={styles.sectionTitle}>{copy.overview}</Text>
            {overview ? (
              <View style={styles.overviewGrid}>
                <OverviewTile
                  icon="navigate-outline"
                  title={copy.lastLocation}
                  value={locationStatusLabel(copy, overview.locationStatus)}
                />
                <OverviewTile
                  icon="notifications-outline"
                  title={copy.separationAlerts}
                  value={overview.separationAlerts ? copy.on : copy.off}
                />
                <OverviewTile
                  icon="phone-portrait-outline"
                  title={copy.phoneProtection}
                  value={companionStatusLabel(copy, overview.companionStatus)}
                />
                <OverviewTile
                  icon="repeat-outline"
                  title={copy.replacement}
                  value={overview.replacementEligible ? copy.eligible : copy.notEligible}
                />
              </View>
            ) : premiumLoading ? (
              <Surface style={styles.centerCard}>
                <ActivityIndicator color={colors.blue} />
                <Text style={styles.centerText}>{copy.loading}</Text>
              </Surface>
            ) : (
              <Surface style={styles.errorCard}>
                <Text style={styles.errorText}>{copy.loadError}</Text>
                <OutlineButton label={copy.retry} onPress={() => void refresh()} />
              </Surface>
            )}

            {safeZonesAvailable ? (
              <View style={styles.safeZoneSection}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionHeaderCopy}>
                    <Text style={styles.sectionTitle}>{copy.safeZones}</Text>
                    <Text style={styles.sectionBody}>{copy.safeZonesBody}</Text>
                    <Text style={styles.zoneCount}>
                      {interpolateProtectionCopy(copy.zoneLimit, {
                        count: String(safeZoneState.zones.length),
                      })}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.addZone}
                    disabled={
                      safeZoneState.mutating || safeZoneState.zones.length >= SAFE_ZONE_LIMIT
                    }
                    onPress={openNewZone}
                    style={({ pressed }) => [
                      styles.addZoneButton,
                      (safeZoneState.mutating || safeZoneState.zones.length >= SAFE_ZONE_LIMIT) &&
                        styles.disabled,
                      pressed && styles.pressed,
                    ]}
                    testID="add-safe-zone"
                  >
                    <Ionicons name="add" size={24} color="#FFFFFF" />
                  </Pressable>
                </View>

                {safeZoneState.loading && !safeZoneState.zones.length ? (
                  <Surface style={styles.centerCard}>
                    <ActivityIndicator color={colors.blue} />
                    <Text style={styles.centerText}>{copy.loading}</Text>
                  </Surface>
                ) : safeZoneState.error && !safeZoneState.zones.length ? (
                  <Surface style={styles.errorCard}>
                    <Text style={styles.errorText}>{copy.loadError}</Text>
                    <OutlineButton label={copy.retry} onPress={() => void safeZoneState.refresh()} />
                  </Surface>
                ) : safeZoneState.zones.length ? (
                  <View style={styles.zoneList}>
                    {safeZoneState.zones.map((zone) => (
                      <ZoneRow
                        key={zone.id}
                        zone={zone}
                        copy={copy}
                        language={language}
                        disabled={safeZoneState.mutating}
                        onEdit={() => openZone(zone)}
                        onDelete={() => confirmDelete(zone)}
                      />
                    ))}
                  </View>
                ) : (
                  <Surface style={styles.emptyCard}>
                    <View style={styles.emptyIcon}>
                      <Ionicons name="location-outline" size={30} color={colors.blue} />
                    </View>
                    <Text style={styles.emptyTitle}>{copy.emptyZonesTitle}</Text>
                    <Text style={styles.emptyBody}>{copy.emptyZonesBody}</Text>
                    <PrimaryButton
                      label={copy.addZone}
                      icon="add-circle-outline"
                      onPress={openNewZone}
                      testID="add-first-safe-zone"
                    />
                  </Surface>
                )}
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Surface style={styles.lockedHero}>
              <View style={styles.lockedIcon}>
                <Ionicons name="lock-closed" size={29} color={colors.blue} />
              </View>
              <Text style={styles.lockedTitle}>{copy.lockedTitle}</Text>
              <Text style={styles.lockedBody}>{copy.lockedBody}</Text>
              <PrimaryButton
                label={copy.managePlan}
                icon="cloud-outline"
                onPress={onOpenSubscription}
                testID="protection-open-subscription"
              />
            </Surface>
            <CloudPlusFeatures />
          </>
        )}
      </ScrollView>

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(draft)}
        onRequestClose={() => setDraft(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setDraft(null)} />
          <SafeAreaView edges={['bottom']} style={styles.editorSafeArea}>
            <View style={styles.editorCard}>
              <View style={styles.editorHeader}>
                <View>
                  <Text style={styles.editorEyebrow}>PINKEVA CLOUD +</Text>
                  <Text style={styles.editorTitle}>{draft?.id ? copy.editZone : copy.newZone}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                  onPress={() => setDraft(null)}
                  style={styles.closeButton}
                >
                  <Ionicons name="close" size={23} color={colors.mutedDark} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.editorFields}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <EditorField
                  label={copy.zoneName}
                  value={draft?.name ?? ''}
                  maxLength={80}
                  onChangeText={(name) => setDraft((current) => current ? { ...current, name } : null)}
                  testID="safe-zone-name"
                />
                <View style={styles.coordinateRow}>
                  <EditorField
                    compact
                    label={copy.latitude}
                    value={draft?.latitude ?? ''}
                    keyboardType="numbers-and-punctuation"
                    onChangeText={(latitude) => setDraft((current) => current ? { ...current, latitude } : null)}
                    testID="safe-zone-latitude"
                  />
                  <EditorField
                    compact
                    label={copy.longitude}
                    value={draft?.longitude ?? ''}
                    keyboardType="numbers-and-punctuation"
                    onChangeText={(longitude) => setDraft((current) => current ? { ...current, longitude } : null)}
                    testID="safe-zone-longitude"
                  />
                </View>
                {hasTrackerCoordinate(tracker) ? (
                  <OutlineButton
                    label={copy.useTrackerLocation}
                    icon="locate-outline"
                    onPress={() => setDraft((current) => current ? {
                      ...current,
                      latitude: String(tracker.latitude),
                      longitude: String(tracker.longitude),
                    } : null)}
                  />
                ) : null}
                <EditorField
                  label={copy.radius}
                  value={draft?.radiusMeters ?? ''}
                  keyboardType="number-pad"
                  onChangeText={(radiusMeters) => setDraft((current) => current ? { ...current, radiusMeters } : null)}
                  testID="safe-zone-radius"
                />
                <Text style={styles.radiusHint}>{copy.radiusHint}</Text>
                {draftError ? (
                  <View style={styles.draftError}>
                    <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
                    <Text style={styles.draftErrorText}>{draftError}</Text>
                  </View>
                ) : null}
                <PrimaryButton
                  label={t('common.save')}
                  icon="checkmark-circle-outline"
                  disabled={safeZoneState.mutating}
                  onPress={() => void saveZone()}
                  testID="save-safe-zone"
                />
                <OutlineButton
                  label={t('common.cancel')}
                  onPress={() => setDraft(null)}
                />
              </ScrollView>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </AppSafeArea>
  );
}

function OverviewTile({
  icon,
  title,
  value,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  value: string;
}) {
  return (
    <Surface style={styles.overviewTile}>
      <View style={styles.overviewIcon}>
        <Ionicons name={icon} size={22} color={colors.blue} />
      </View>
      <Text style={styles.overviewLabel}>{title}</Text>
      <Text style={styles.overviewValue}>{value}</Text>
    </Surface>
  );
}

function ZoneRow({
  zone,
  copy,
  language,
  disabled,
  onEdit,
  onDelete,
}: {
  zone: DeviceSafeZone;
  copy: ProtectionCopy;
  language: Language;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stateLabel = !zone.enabled
    ? copy.paused
    : zone.lastTrackerInside === true
      ? copy.trackerInside
      : zone.lastTrackerInside === false
        ? copy.trackerOutside
        : copy.awaitingEvaluation;
  const evaluated = zone.lastEvaluatedAt
    ? interpolateProtectionCopy(copy.lastEvaluated, {
        date: formatEvaluationDate(zone.lastEvaluatedAt, language),
      })
    : null;
  return (
    <View style={styles.zoneRow} testID={`safe-zone-${zone.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${zone.name}, ${stateLabel}`}
        disabled={disabled}
        onPress={onEdit}
        style={({ pressed }) => [styles.zoneEdit, pressed && styles.pressed]}
      >
        <View style={[
          styles.zoneIcon,
          zone.lastTrackerInside === false && styles.zoneIconOutside,
        ]}>
          <Ionicons
            name={zone.lastTrackerInside === false ? 'exit-outline' : 'location'}
            size={23}
            color={zone.lastTrackerInside === false ? '#B95000' : colors.blue}
          />
        </View>
        <View style={styles.zoneCopy}>
          <Text numberOfLines={1} style={styles.zoneName}>{zone.name}</Text>
          <Text style={styles.zoneMeta}>
            {zone.latitude.toFixed(5)}, {zone.longitude.toFixed(5)} · {zone.radiusMeters} m
          </Text>
          <Text style={[
            styles.zoneState,
            zone.lastTrackerInside === false && styles.zoneStateOutside,
          ]}>
            {stateLabel}
          </Text>
          {evaluated ? <Text style={styles.zoneEvaluated}>{evaluated}</Text> : null}
        </View>
        <Ionicons name="create-outline" size={21} color={colors.muted} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy.deleteAction} ${zone.name}`}
        disabled={disabled}
        onPress={onDelete}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
      >
        <Ionicons name="trash-outline" size={21} color={colors.danger} />
      </Pressable>
    </View>
  );
}

function EditorField({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  maxLength,
  compact = false,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: React.ComponentProps<typeof TextInput>['keyboardType'];
  maxLength?: number;
  compact?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.field, compact && styles.fieldCompact]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={keyboardType === 'default' ? 'words' : 'none'}
        autoCorrect={keyboardType === 'default'}
        keyboardType={keyboardType}
        maxLength={maxLength}
        onChangeText={onChangeText}
        style={styles.input}
        value={value}
        testID={testID}
      />
    </View>
  );
}

function parseZoneDraft(draft: ZoneDraft, copy: ProtectionCopy): SafeZoneInput | string {
  const name = draft.name.trim().split(/\s+/).join(' ');
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return copy.invalidName;
  const latitude = parseLocalizedNumber(draft.latitude);
  const longitude = parseLocalizedNumber(draft.longitude);
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) return copy.invalidCoordinates;
  const radiusMeters = Number(draft.radiusMeters.trim());
  if (
    !Number.isSafeInteger(radiusMeters) ||
    radiusMeters < SAFE_ZONE_MIN_RADIUS_METERS ||
    radiusMeters > SAFE_ZONE_MAX_RADIUS_METERS
  ) return copy.invalidRadius;
  return { name, latitude, longitude, radiusMeters };
}

function parseLocalizedNumber(value: string): number {
  const normalized = value.trim().replace(',', '.');
  return normalized ? Number(normalized) : Number.NaN;
}

function numberInputValue(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function hasTrackerCoordinate(
  tracker: Tracker,
): tracker is Tracker & { latitude: number; longitude: number } {
  return (
    typeof tracker.latitude === 'number' &&
    Number.isFinite(tracker.latitude) &&
    typeof tracker.longitude === 'number' &&
    Number.isFinite(tracker.longitude)
  );
}

function formatEvaluationDate(value: string, language: Language): string {
  try {
    return new Date(value).toLocaleString(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(value).toLocaleString();
  }
}

function locationStatusLabel(
  copy: ProtectionCopy,
  status: PremiumTrackerOverview['locationStatus'],
): string {
  if (status === 'current') return copy.locationCurrent;
  if (status === 'stale') return copy.locationStale;
  return copy.locationNever;
}

function companionStatusLabel(
  copy: ProtectionCopy,
  status: PremiumTrackerOverview['companionStatus'],
): string {
  if (status === 'ready') return copy.ready;
  if (status === 'stale') return copy.stale;
  return copy.notConfigured;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 38, gap: 18 },
  activeHero: {
    padding: 20,
    borderRadius: radii.large,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 15,
    backgroundColor: colors.navy,
  },
  heroIcon: {
    width: 58,
    height: 58,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blue,
  },
  heroCopy: { flex: 1, gap: 5 },
  heroEyebrow: { color: '#9EBCFF', fontSize: 11, lineHeight: 15, fontWeight: '900', letterSpacing: 1 },
  heroTitle: { color: '#FFFFFF', fontSize: 22, lineHeight: 27, fontWeight: '900' },
  heroBody: { color: '#D7E2FA', fontSize: 13, lineHeight: 19 },
  lockedHero: { padding: 22, borderRadius: radii.large, alignItems: 'center', gap: 11 },
  lockedIcon: { width: 62, height: 62, borderRadius: 21, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  lockedTitle: { color: colors.text, fontSize: 24, lineHeight: 29, fontWeight: '900', textAlign: 'center' },
  lockedBody: { color: colors.mutedDark, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 4 },
  sectionTitle: { color: colors.text, fontSize: 22, lineHeight: 27, fontWeight: '900' },
  sectionBody: { color: colors.mutedDark, fontSize: 14, lineHeight: 20, marginTop: 4 },
  overviewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 11 },
  overviewTile: { width: '48.2%', minHeight: 132, padding: 14, borderRadius: radii.medium },
  overviewIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale },
  overviewLabel: { color: colors.muted, fontSize: 12, lineHeight: 16, fontWeight: '700', marginTop: 12 },
  overviewValue: { color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: '900', marginTop: 3 },
  safeZoneSection: { gap: 13, marginTop: 2 },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  sectionHeaderCopy: { flex: 1 },
  zoneCount: { color: colors.blue, fontSize: 12, lineHeight: 16, fontWeight: '800', marginTop: 7 },
  addZoneButton: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue, ...shadow },
  zoneList: { borderRadius: radii.large, overflow: 'hidden', backgroundColor: '#FFFFFF', ...shadow },
  zoneRow: { minHeight: 120, flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  zoneEdit: { flex: 1, minWidth: 0, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 11 },
  zoneIcon: { width: 47, height: 47, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale },
  zoneIconOutside: { backgroundColor: '#FFF0E6' },
  zoneCopy: { flex: 1, minWidth: 0 },
  zoneName: { color: colors.text, fontSize: 17, lineHeight: 21, fontWeight: '900' },
  zoneMeta: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  zoneState: { color: colors.blue, fontSize: 12, lineHeight: 16, fontWeight: '800', marginTop: 5 },
  zoneStateOutside: { color: '#A54900' },
  zoneEvaluated: { color: colors.mutedDark, fontSize: 11, lineHeight: 15, marginTop: 2 },
  deleteButton: { width: 50, alignItems: 'center', justifyContent: 'center', borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  centerCard: { minHeight: 120, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 10 },
  centerText: { color: colors.mutedDark, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  errorCard: { padding: 20, alignItems: 'center', gap: 12 },
  errorText: { color: colors.mutedDark, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  emptyCard: { padding: 22, alignItems: 'center', gap: 10 },
  emptyIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 20, lineHeight: 25, fontWeight: '900', textAlign: 'center' },
  emptyBody: { color: colors.mutedDark, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 3 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(3, 13, 37, 0.52)' },
  editorSafeArea: { maxHeight: '88%', backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  editorCard: { maxHeight: '100%', paddingTop: 18 },
  editorHeader: { paddingHorizontal: 20, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  editorEyebrow: { color: colors.blue, fontSize: 10, lineHeight: 14, fontWeight: '900', letterSpacing: 1 },
  editorTitle: { color: colors.text, fontSize: 25, lineHeight: 30, fontWeight: '900', marginTop: 2 },
  closeButton: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  editorFields: { paddingHorizontal: 20, paddingBottom: 22, gap: 12 },
  field: { gap: 6 },
  fieldCompact: { flex: 1 },
  fieldLabel: { color: colors.text, fontSize: 13, lineHeight: 17, fontWeight: '800' },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 15, paddingHorizontal: 14, color: colors.text, backgroundColor: colors.background, fontSize: 16 },
  coordinateRow: { flexDirection: 'row', gap: 10 },
  radiusHint: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: -6 },
  draftError: { padding: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FFF0F0' },
  draftErrorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.42 },
});
