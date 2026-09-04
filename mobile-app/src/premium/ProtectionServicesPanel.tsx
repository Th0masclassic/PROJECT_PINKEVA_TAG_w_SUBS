import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { OutlineButton, PrimaryButton, Surface } from '../components';
import { getInstallationId } from '../device/installationId';
import type { Tracker } from '../model';
import type { ProvisioningApiConfig } from '../provisioning/api';
import { colors, radii } from '../theme';
import {
  MOVEMENT_THRESHOLD_MAX_METERS,
  MOVEMENT_THRESHOLD_MIN_METERS,
  recoveryShareUrl,
  SEPARATION_THRESHOLD_MAX_METERS,
  SEPARATION_THRESHOLD_MIN_METERS,
  type ProtectionProfileUpdate,
  type ReplacementClaimStatus,
} from './api';
import type { ProtectionServicesState } from './useProtectionServices';

export function ProtectionServicesPanel({
  tracker,
  services,
  apiConfig,
  onNotice,
  onRefreshOverview,
}: {
  tracker: Tracker;
  services: ProtectionServicesState;
  apiConfig: ProvisioningApiConfig | null;
  onNotice: (message: string) => void;
  onRefreshOverview: () => Promise<void>;
}) {
  const [separationThreshold, setSeparationThreshold] = useState('500');
  const [movementThreshold, setMovementThreshold] = useState('750');
  const [shareLabel, setShareLabel] = useState('Recovery contact');
  const [shareAccess, setShareAccess] = useState<'latest' | 'history'>('latest');
  const [shareHours, setShareHours] = useState(72);
  const [lastShareUrl, setLastShareUrl] = useState<string | null>(null);
  const [claimNotes, setClaimNotes] = useState('');

  useEffect(() => {
    if (!services.profile) return;
    setSeparationThreshold(String(services.profile.separationThresholdMeters));
    setMovementThreshold(String(services.profile.movementThresholdMeters));
  }, [services.profile]);

  const activeShares = useMemo(
    () => services.shares.filter((share) =>
      !share.revokedAt && Date.parse(share.expiresAt) > Date.now()),
    [services.shares],
  );

  const saveProfile = async (update: ProtectionProfileUpdate, message: string) => {
    try {
      await services.updateProfile(update);
      onNotice(services.mode === 'demo' ? 'Preview setting updated on this phone only.' : message);
      if (services.mode === 'live') await onRefreshOverview();
    } catch {
      onNotice('The protection setting could not be saved.');
    }
  };

  const saveThresholds = async () => {
    const separation = Number(separationThreshold.trim());
    const movement = Number(movementThreshold.trim());
    if (!Number.isSafeInteger(separation) ||
      separation < SEPARATION_THRESHOLD_MIN_METERS ||
      separation > SEPARATION_THRESHOLD_MAX_METERS
    ) {
      onNotice(`Separation threshold must be ${SEPARATION_THRESHOLD_MIN_METERS}–${SEPARATION_THRESHOLD_MAX_METERS} metres.`);
      return;
    }
    if (!Number.isSafeInteger(movement) ||
      movement < MOVEMENT_THRESHOLD_MIN_METERS ||
      movement > MOVEMENT_THRESHOLD_MAX_METERS
    ) {
      onNotice(`Movement threshold must be ${MOVEMENT_THRESHOLD_MIN_METERS}–${MOVEMENT_THRESHOLD_MAX_METERS} metres.`);
      return;
    }
    await saveProfile({
      separationThresholdMeters: separation,
      movementThresholdMeters: movement,
    }, 'Alert thresholds saved.');
  };

  const updateThisPhone = async () => {
    if (services.mode !== 'live') {
      onNotice('Phone registration is disabled in preview mode.');
      return;
    }
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      onNotice('Main-phone protection is available in the iPhone and Android app.');
      return;
    }
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        onNotice('Location permission is required to update main-phone protection.');
        return;
      }
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const status = await services.observeCompanion({
        installationId: await getInstallationId(),
        platform: Platform.OS,
        phoneLatitude: location.coords.latitude,
        phoneLongitude: location.coords.longitude,
        phoneAccuracyMeters: Math.max(1, Math.min(1_000, location.coords.accuracy ?? 100)),
        sampledAt: new Date(location.timestamp).toISOString(),
        tagProximity: 'unknown',
      });
      onNotice(status.observationAccepted === false
        ? 'This phone observation was already recorded.'
        : 'Main-phone location updated. No Bluetooth proximity was claimed.');
      await onRefreshOverview();
    } catch {
      onNotice('Main-phone protection could not be updated.');
    }
  };

  const removeThisPhone = () => {
    Alert.alert(
      'Remove main phone?',
      'Phone-aware separation checks will stop until another phone observation is registered.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void services.removeCompanion()
              .then(async () => {
                onNotice('Main phone removed.');
                await onRefreshOverview();
              })
              .catch(() => onNotice('The main phone could not be removed.'));
          },
        },
      ],
    );
  };

  const shareCreatedLink = async (url: string) => {
    try {
      await Share.share({
        title: `${tracker.name} recovery link`,
        message: `Pinkeva recovery link for ${tracker.name}: ${url}`,
        url,
      });
    } catch {
      onNotice('The link was created, but the share sheet could not be opened.');
    }
  };

  const createShareLink = async () => {
    if (services.mode !== 'live' || !apiConfig) {
      onNotice('Real recovery links are disabled in preview mode.');
      return;
    }
    try {
      const created = await services.createShare({
        label: shareLabel,
        accessLevel: shareAccess,
        expiresInHours: shareHours,
      });
      const url = recoveryShareUrl(apiConfig, created);
      setLastShareUrl(url);
      onNotice('Backend-issued recovery link created.');
      await shareCreatedLink(url);
      await onRefreshOverview();
    } catch {
      onNotice('The recovery link could not be created.');
    }
  };

  const revokeShare = (shareId: string, label: string) => {
    Alert.alert('Revoke recovery link?', `${label} will stop resolving immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          void services.revokeShare(shareId)
            .then(async () => {
              onNotice('Recovery link revoked.');
              await onRefreshOverview();
            })
            .catch(() => onNotice('The recovery link could not be revoked.'));
        },
      },
    ]);
  };

  const submitClaim = (reason: 'lost' | 'stolen') => {
    if (services.mode !== 'live') {
      onNotice('Replacement claims are disabled in preview mode.');
      return;
    }
    Alert.alert(
      `Report tracker as ${reason}?`,
      'The incident time will be recorded as now. Claims are reviewed by a Pinkeva administrator and are not automatically approved.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit claim',
          onPress: () => {
            void services.submitClaim({
              reason,
              incidentAt: new Date().toISOString(),
              ...(claimNotes.trim() ? { notes: claimNotes.trim() } : {}),
            }).then(async () => {
              setClaimNotes('');
              onNotice('Replacement claim submitted for review.');
              await onRefreshOverview();
            }).catch(() => onNotice('The replacement claim could not be submitted.'));
          },
        },
      ],
    );
  };

  const eraseLocationHistory = () => {
    if (services.mode !== 'live') {
      onNotice('Location-history deletion is disabled in preview mode.');
      return;
    }
    Alert.alert(
      'Delete location history?',
      'This permanently deletes Pinkeva’s stored reports for this tracker. It does not erase the tracker or its finder identities.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete history',
          style: 'destructive',
          onPress: () => {
            void services.eraseHistory()
              .then(async (result) => {
                onNotice(`${result.deletedReports} stored location report${result.deletedReports === 1 ? '' : 's'} deleted.`);
                await onRefreshOverview();
              })
              .catch(() => onNotice('Location history could not be deleted.'));
          },
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      {services.mode === 'demo' ? (
        <View style={styles.previewBanner} testID="protection-preview-banner">
          <Ionicons name="flask-outline" size={22} color="#704600" />
          <Text style={styles.previewText}>Preview only — sample data and setting changes stay on this phone. No live tracker, claim, share link, or deletion is performed.</Text>
        </View>
      ) : null}

      <SectionHeader
        title="Alert settings"
        body="These controls use the backend’s protection profile and exact threshold limits."
      />
      {services.profile ? (
        <Surface style={styles.card}>
          <ToggleRow
            title="Separation alerts"
            detail="Alert when phone and tracker reports cross the configured distance."
            value={services.profile.separationAlerts}
            disabled={Boolean(services.mutating)}
            onChange={(value) => void saveProfile({ separationAlerts: value }, 'Separation alerts updated.')}
          />
          <ToggleRow
            title="Movement alerts"
            detail="Use the tracker’s latest accepted location as the movement anchor."
            value={services.profile.movementAlerts}
            disabled={Boolean(services.mutating)}
            onChange={(value) => void saveProfile({ movementAlerts: value }, 'Movement alerts updated.')}
          />
          <ToggleRow
            title="Vehicle mode"
            detail="Apply the backend’s vehicle-aware movement protection behavior."
            value={services.profile.vehicleMode}
            disabled={Boolean(services.mutating)}
            onChange={(value) => void saveProfile({ vehicleMode: value }, 'Vehicle mode updated.')}
          />
          <View style={styles.thresholdGrid}>
            <NumberField
              label="Separation metres"
              value={separationThreshold}
              onChange={setSeparationThreshold}
            />
            <NumberField
              label="Movement metres"
              value={movementThreshold}
              onChange={setMovementThreshold}
            />
          </View>
          <OutlineButton
            label={services.mutating === 'profile' ? 'Saving…' : 'Save alert thresholds'}
            disabled={Boolean(services.mutating)}
            onPress={() => void saveThresholds()}
          />
        </Surface>
      ) : <LoadingCard text={services.loading ? 'Loading alert settings…' : 'Alert settings are unavailable.'} />}

      <SectionHeader
        title="Companion phone protection"
        body="Register a fresh phone GPS observation. This action reports tag proximity as unknown; it never pretends a Bluetooth scan succeeded."
      />
      <Surface style={styles.card}>
        <StatusLine
          icon="phone-portrait-outline"
          title={services.companion?.configured ? 'Main phone configured' : 'No main phone configured'}
          detail={services.companion?.lastObservationAt
            ? `Last observation ${formatDate(services.companion.lastObservationAt)}`
            : 'No phone observation has been accepted yet.'}
        />
        <PrimaryButton
          label={services.mutating === 'companion' ? 'Updating…' : 'Update from this phone'}
          icon="locate-outline"
          disabled={Boolean(services.mutating) || services.mode === 'unavailable'}
          onPress={() => void updateThisPhone()}
        />
        {services.companion?.configured && services.mode === 'live' ? (
          <OutlineButton
            label="Remove main phone"
            disabled={Boolean(services.mutating)}
            onPress={removeThisPhone}
          />
        ) : null}
      </Surface>

      <SectionHeader
        title="Recovery report"
        body="A backend-generated summary of accepted evidence and current recovery readiness."
      />
      {services.report ? (
        <View style={styles.reportGrid}>
          <Metric label="Locations (30d)" value={String(services.report.locationCount30d)} />
          <Metric label="Recent alerts" value={String(services.report.recentAlertCount30d)} />
          <Metric label="Safe zones" value={String(services.report.safeZoneCount)} />
          <Metric label="Active links" value={String(services.report.activeShareCount)} />
        </View>
      ) : <LoadingCard text={services.loading ? 'Generating recovery report…' : 'Recovery report unavailable.'} />}

      <SectionHeader
        title="Recovery sharing links"
        body="Links are created by the backend, expire automatically, and can be revoked here. Existing plaintext tokens are never returned again."
      />
      <Surface style={styles.card}>
        <TextInput
          accessibilityLabel="Recovery link label"
          value={shareLabel}
          maxLength={80}
          onChangeText={setShareLabel}
          placeholder="Recovery contact"
          style={styles.input}
        />
        <Segmented
          values={[
            { id: 'latest', label: 'Latest only' },
            { id: 'history', label: '30-day history' },
          ]}
          selected={shareAccess}
          onSelect={(value) => setShareAccess(value as 'latest' | 'history')}
        />
        <Segmented
          values={[
            { id: '24', label: '24 hours' },
            { id: '72', label: '3 days' },
            { id: '168', label: '7 days' },
          ]}
          selected={String(shareHours)}
          onSelect={(value) => setShareHours(Number(value))}
        />
        <PrimaryButton
          label={services.mutating === 'share' ? 'Creating…' : 'Create recovery link'}
          icon="share-social-outline"
          disabled={Boolean(services.mutating) || services.mode !== 'live'}
          onPress={() => void createShareLink()}
        />
        {lastShareUrl ? (
          <OutlineButton label="Share newly created link again" onPress={() => void shareCreatedLink(lastShareUrl)} />
        ) : null}
      </Surface>
      {activeShares.length ? (
        <View style={styles.stack}>
          {activeShares.map((share) => (
            <Surface key={share.id} style={styles.listCard}>
              <StatusLine
                icon="link-outline"
                title={share.label}
                detail={`${share.accessLevel === 'history' ? 'History' : 'Latest location'} · expires ${formatDate(share.expiresAt)}`}
              />
              {services.mode === 'live' ? (
                <OutlineButton
                  label="Revoke link"
                  disabled={Boolean(services.mutating)}
                  onPress={() => revokeShare(share.id, share.label)}
                />
              ) : null}
            </Surface>
          ))}
        </View>
      ) : <LoadingCard text="No active recovery links." />}

      <SectionHeader
        title="Replacement eligibility and claims"
        body="Only the backend decides eligibility. Submissions remain pending until an administrator reviews them."
      />
      <Surface style={styles.card}>
        <StatusLine
          icon="repeat-outline"
          title={services.eligibility?.eligible ? 'Eligible this billing period' : 'Not currently eligible'}
          detail={eligibilityDetail(services.eligibility?.reason)}
        />
        {services.eligibility?.eligible ? (
          <>
            <TextInput
              accessibilityLabel="Optional replacement claim notes"
              value={claimNotes}
              onChangeText={setClaimNotes}
              maxLength={500}
              multiline
              placeholder="Optional incident notes"
              style={[styles.input, styles.notesInput]}
            />
            <View style={styles.actionRow}>
              <OutlineButton
                label="Report lost now"
                disabled={Boolean(services.mutating)}
                onPress={() => submitClaim('lost')}
                style={styles.flexButton}
              />
              <OutlineButton
                label="Report stolen now"
                disabled={Boolean(services.mutating)}
                onPress={() => submitClaim('stolen')}
                style={styles.flexButton}
              />
            </View>
          </>
        ) : null}
        {services.claims.map((claim) => (
          <View key={claim.id} style={styles.claimRow}>
            <Text style={styles.claimTitle}>{claim.reason === 'lost' ? 'Lost' : 'Stolen'} claim</Text>
            <Text style={styles.claimStatus}>{claimStatusLabel(claim.status)}</Text>
            <Text style={styles.claimDate}>Submitted {formatDate(claim.submittedAt)}</Text>
          </View>
        ))}
      </Surface>

      <SectionHeader
        title="Location-history privacy"
        body="Delete only Pinkeva’s stored location reports for this tracker. Finder identities and ownership remain unchanged."
      />
      <Surface style={styles.dangerCard}>
        <StatusLine
          icon="trash-outline"
          title="Delete stored location history"
          detail="This cannot be undone. The backend returns the exact number of deleted reports."
        />
        <OutlineButton
          label={services.mutating === 'history' ? 'Deleting…' : 'Delete location history'}
          disabled={Boolean(services.mutating) || services.mode !== 'live'}
          onPress={eraseLocationHistory}
        />
      </Surface>

      {services.error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
          <Text style={styles.errorText}>Some protection details could not be loaded. Pull to refresh and try again.</Text>
        </View>
      ) : null}
    </View>
  );
}

function SectionHeader({ title, body }: { title: string; body: string }) {
  return <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionBody}>{body}</Text></View>;
}

function ToggleRow({ title, detail, value, disabled, onChange }: {
  title: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.rowDetail}>{detail}</Text></View>
      <Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{ false: '#CED4DF', true: '#8BAEFF' }} thumbColor={value ? colors.blue : '#FFFFFF'} />
    </View>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <View style={styles.numberField}><Text style={styles.fieldLabel}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} keyboardType="number-pad" style={styles.input} /></View>;
}

function StatusLine({ icon, title, detail }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; detail: string }) {
  return <View style={styles.statusLine}><View style={styles.statusIcon}><Ionicons name={icon} size={23} color={colors.blue} /></View><View style={styles.statusCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.rowDetail}>{detail}</Text></View></View>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Surface style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></Surface>;
}

function LoadingCard({ text }: { text: string }) {
  return <Surface style={styles.loadingCard}><Text style={styles.loadingText}>{text}</Text></Surface>;
}

function Segmented({ values, selected, onSelect }: { values: Array<{ id: string; label: string }>; selected: string; onSelect: (id: string) => void }) {
  return <View style={styles.segmented}>{values.map((value) => <Pressable key={value.id} accessibilityRole="radio" accessibilityState={{ selected: selected === value.id }} onPress={() => onSelect(value.id)} style={[styles.segment, selected === value.id && styles.segmentSelected]}><Text style={[styles.segmentText, selected === value.id && styles.segmentTextSelected]}>{value.label}</Text></Pressable>)}</View>;
}

function formatDate(value: string): string {
  try { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(value).toLocaleString(); }
}

function eligibilityDetail(reason: string | undefined): string {
  if (reason === 'eligible') return 'The backend confirms the current paid plan and benefit period are eligible.';
  if (reason === 'subscription_required') return 'An active subscription is required.';
  if (reason === 'paid_subscription_required') return 'A paid active subscription is required; trials do not qualify.';
  if (reason === 'plan_not_eligible') return 'This benefit requires an eligible 6- or 12-month plan.';
  if (reason === 'already_claimed') return 'A claim already exists for this benefit period.';
  return 'Eligibility has not been loaded.';
}

function claimStatusLabel(status: ReplacementClaimStatus): string {
  return status === 'submitted' ? 'Submitted' : status === 'approved' ? 'Approved' :
    status === 'rejected' ? 'Rejected' : status === 'fulfilled' ? 'Fulfilled' : 'Cancelled';
}

const styles = StyleSheet.create({
  root: { gap: 14 },
  sectionHeader: { gap: 4, marginTop: 8 },
  sectionTitle: { color: colors.text, fontSize: 22, lineHeight: 27, fontWeight: '900' },
  sectionBody: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  card: { padding: 16, gap: 14 },
  previewBanner: { borderRadius: radii.medium, borderWidth: 1, borderColor: '#F5D58A', backgroundColor: '#FFF5D9', padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  previewText: { flex: 1, color: '#745516', fontSize: 13, lineHeight: 19, fontWeight: '600' },
  toggleRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: 12 },
  toggleCopy: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontSize: 16, lineHeight: 21, fontWeight: '800' },
  rowDetail: { color: colors.mutedDark, fontSize: 12, lineHeight: 18, marginTop: 3 },
  thresholdGrid: { flexDirection: 'row', gap: 10 },
  numberField: { flex: 1, gap: 5 },
  fieldLabel: { color: colors.text, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 13, color: colors.text, backgroundColor: colors.background, fontSize: 15 },
  notesInput: { minHeight: 78, paddingTop: 12, textAlignVertical: 'top' },
  statusLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  statusIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale },
  statusCopy: { flex: 1 },
  reportGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { width: '48.3%', minHeight: 96, padding: 15, justifyContent: 'center' },
  metricValue: { color: colors.blue, fontSize: 27, fontWeight: '900' },
  metricLabel: { color: colors.mutedDark, fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 5 },
  segmented: { minHeight: 42, borderRadius: 14, backgroundColor: '#EEF2F8', padding: 3, flexDirection: 'row', gap: 3 },
  segment: { flex: 1, minHeight: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  segmentSelected: { backgroundColor: colors.blue },
  segmentText: { color: colors.mutedDark, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  segmentTextSelected: { color: '#FFFFFF' },
  stack: { gap: 10 },
  listCard: { padding: 15, gap: 12 },
  actionRow: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1 },
  claimRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 12 },
  claimTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  claimStatus: { color: colors.blue, fontSize: 12, fontWeight: '800', marginTop: 3 },
  claimDate: { color: colors.muted, fontSize: 11, marginTop: 3 },
  dangerCard: { padding: 16, gap: 14, borderColor: '#F0CACA' },
  loadingCard: { padding: 18, alignItems: 'center' },
  loadingText: { color: colors.mutedDark, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  errorBanner: { borderRadius: 14, backgroundColor: '#FFF0F0', padding: 13, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 19, fontWeight: '700' },
});
