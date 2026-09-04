import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  AppSafeArea,
  Brand,
  IconButton,
  PrimaryButton,
  TextButton,
  TrackerArtwork,
} from '../components';
import { formatRelativeTime, localizeTrackerPlace, useI18n } from '../i18n';
import { selectClosestLocatedTracker } from '../location/nearestTracker';
import { trackerProximityStatus } from '../location/proximity';
import { useUserLocation } from '../location/useUserLocation';
import { GoogleTrackerMap } from '../maps/GoogleTrackerMap';
import type { Tracker } from '../model';
import type { PremiumFeatureAccess } from '../premium/api';
import { colors, radii, shadow } from '../theme';

export function HomeScreen({
  trackers,
  mainTracker,
  premiumFeatures,
  onOpenTracker,
  onAddTracker,
  onOpenHistory,
  onOpenProtection,
  onOpenCloudPlus,
  onOpenNotifications,
  unreadNotificationCount,
  onNotice,
}: {
  trackers: Tracker[];
  mainTracker?: Tracker;
  premiumFeatures: Record<string, PremiumFeatureAccess>;
  onOpenTracker: (trackerId: string) => void;
  onAddTracker: () => void;
  onOpenHistory: (trackerId: string) => void;
  onOpenProtection: (trackerId: string) => void;
  onOpenCloudPlus: (trackerId: string) => void;
  onOpenNotifications: () => void;
  unreadNotificationCount: number;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const userCoordinate = useUserLocation(trackers.length > 0);
  const closestLocatedTracker = useMemo(
    () => selectClosestLocatedTracker(trackers, userCoordinate, mainTracker?.id),
    [mainTracker?.id, trackers, userCoordinate],
  );
  const focusedTracker = closestLocatedTracker ?? mainTracker ?? trackers[0];
  const mapTrackers = useMemo(
    () => (focusedTracker ? [focusedTracker] : []),
    [focusedTracker],
  );
  if (!focusedTracker) {
    return <TrackerSetupStart onAddTracker={onAddTracker} onNotice={onNotice} />;
  }

  // The backend status is a safe fallback when the phone has denied location
  // permission or the tracker has not reported coordinates yet. Once both
  // points are available, the Home card reflects the physical distance using
  // the selected tracker type (100 m for Card/Keys/Bag, 1 km for Car).
  const proximityStatus = trackerProximityStatus(focusedTracker, userCoordinate);
  const displayStatus = proximityStatus ?? focusedTracker.status;

  return (
    <AppSafeArea style={styles.safeArea}>
      <View style={styles.container} testID="home-screen">
        <View style={styles.mapSection}>
          <GoogleTrackerMap
            trackers={mapTrackers}
            mapType="standard"
            recenterToken={0}
            focusTrackerId={focusedTracker?.id}
            showsUserLocation={Boolean(userCoordinate)}
            onOpenTracker={onOpenTracker}
          />
          <View pointerEvents="none" style={styles.mapWash} />

          <View style={styles.topBar} pointerEvents="box-none">
            <View style={[styles.brandPill, shadow]}>
              <Brand compact />
            </View>
            <View style={[styles.notificationShadow, shadow]}>
              <IconButton
                name="notifications-outline"
                accessibilityLabel={t('a11y.notifications')}
                onPress={onOpenNotifications}
                style={styles.notificationButton}
              />
              {unreadNotificationCount > 0 ? (
                <View pointerEvents="none" style={styles.notificationDot} />
              ) : null}
            </View>
          </View>
        </View>

        <View style={styles.bottomContent} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('a11y.openTracker', { name: focusedTracker.name })}
            onPress={() => onOpenTracker(focusedTracker.id)}
            style={({ pressed }) => [styles.trackerCard, shadow, pressed && styles.pressed]}
            testID="home-closest-tracker"
          >
            <LinearGradient
              colors={['#082C67', '#031638', '#061C45']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.trackerCardGradient}
            >
              <View style={styles.trackerArtwork}>
                <TrackerArtwork
                  kind={focusedTracker.kind}
                  style={styles.trackerArtworkImage}
                  decorative
                  carIconSize={56}
                />
              </View>
              <View style={styles.trackerCopy}>
                <Text numberOfLines={1} style={styles.trackerName}>{focusedTracker.name}</Text>
                <View style={styles.trackerStatus}>
                  <View style={styles.trackerStatusDot} />
                  <Text style={styles.trackerStatusText}>
                    {displayStatus === 'nearby' ? t('tracker.nearby') : t('tracker.away')}
                  </Text>
                </View>
                <Text style={styles.trackerLabel}>{t('home.lastSeen')}</Text>
                <Text numberOfLines={1} style={styles.trackerTime}>
                  {formatRelativeTime(t, focusedTracker.lastSeen)}
                </Text>
                <Text numberOfLines={1} style={styles.trackerMeta}>
                  {localizeTrackerPlace(t, focusedTracker.place)}
                </Text>
              </View>
              <View style={styles.trackerChevron}>
                <Ionicons name="chevron-forward" size={25} color="#FFFFFF" />
              </View>
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </AppSafeArea>
  );
}

function TrackerSetupStart({
  onAddTracker,
  onNotice,
}: {
  onAddTracker: () => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const steps: Array<{
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    body: string;
  }> = [
    {
      icon: 'bluetooth',
      title: t('pairing.scanTitle'),
      body: t('pairing.scanBody'),
    },
    {
      icon: 'shield-checkmark-outline',
      title: t('pairing.stepVerifying'),
      body: t('pairing.keepNear'),
    },
    {
      icon: 'options-outline',
      title: t('trackers.setupTypeTitle'),
      body: t('trackers.setupTypeBody'),
    },
  ];

  return (
    <AppSafeArea style={styles.setupSafeArea}>
      <ScrollView
        contentContainerStyle={styles.setupContent}
        showsVerticalScrollIndicator={false}
        testID="home-tracker-setup"
      >
        <View style={styles.setupBrand}>
          <Brand compact />
        </View>
        <View style={styles.setupArtworkArea}>
          <View style={styles.setupHaloLarge} />
          <View style={styles.setupHaloSmall} />
          <View style={[styles.setupArtworkCard, shadow]}>
            <TrackerArtwork kind="card" style={styles.setupArtwork} decorative />
          </View>
          <View style={[styles.setupBluetoothBadge, shadow]}>
            <Ionicons name="bluetooth" size={28} color="#FFFFFF" />
          </View>
        </View>

        <Text style={styles.setupTitle}>{t('trackers.emptyTitle')}</Text>
        <Text style={styles.setupBody}>{t('trackers.emptyBody')}</Text>

        <View style={styles.setupSteps}>
          {steps.map((step, index) => (
            <View key={step.title} style={styles.setupStep}>
              <View style={styles.setupStepIcon}>
                <Ionicons name={step.icon} size={23} color={colors.blue} />
              </View>
              <View style={styles.setupStepCopy}>
                <Text style={styles.setupStepNumber}>{index + 1}</Text>
                <Text style={styles.setupStepTitle}>{step.title}</Text>
                <Text style={styles.setupStepBody}>{step.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <PrimaryButton
          label={t('trackers.add')}
          icon="bluetooth"
          onPress={onAddTracker}
          style={styles.setupPrimary}
          testID="home-start-setup"
        />
        <TextButton
          label={t('trackers.learn')}
          onPress={() => onNotice(t('trackers.learnNotice'))}
        />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.mapWater },
  setupSafeArea: { backgroundColor: colors.background },
  setupContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 26, alignItems: 'center' },
  setupBrand: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center' },
  setupArtworkArea: { width: '100%', height: 220, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  setupHaloLarge: { position: 'absolute', width: 236, height: 178, borderRadius: 90, backgroundColor: '#E7EFFF', transform: [{ rotate: '-7deg' }] },
  setupHaloSmall: { position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: '#D8E5FF' },
  setupArtworkCard: { width: 190, height: 132, borderRadius: 28, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  setupArtwork: { width: 174, height: 116 },
  setupBluetoothBadge: { position: 'absolute', right: '19%', bottom: 31, width: 54, height: 54, borderRadius: 20, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  setupTitle: { color: colors.text, fontSize: 31, lineHeight: 36, fontWeight: '800', textAlign: 'center' },
  setupBody: { color: colors.mutedDark, fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 9, paddingHorizontal: 10 },
  setupSteps: { width: '100%', gap: 10, marginTop: 22 },
  setupStep: { minHeight: 76, borderRadius: radii.medium, padding: 13, flexDirection: 'row', gap: 12, backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  setupStepIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  setupStepCopy: { flex: 1, paddingRight: 4 },
  setupStepNumber: { position: 'absolute', right: 0, top: 0, color: '#C9D5EB', fontSize: 12, fontWeight: '800' },
  setupStepTitle: { color: colors.text, fontSize: 15, lineHeight: 19, fontWeight: '800', paddingRight: 22 },
  setupStepBody: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  setupPrimary: { width: '100%', marginTop: 22 },
  container: { flex: 1, backgroundColor: colors.background, overflow: 'hidden' },
  mapSection: { flex: 1, minHeight: 300, overflow: 'hidden', backgroundColor: colors.mapWater },
  mapWash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(228,243,255,0.12)',
  },
  topBar: {
    position: 'absolute',
    top: 16,
    left: 18,
    right: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandPill: {
    minHeight: 52,
    borderRadius: radii.pill,
    paddingHorizontal: 17,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
  },
  notificationButton: {
    width: 52,
    minWidth: 52,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.96)',
  },
  notificationShadow: { borderRadius: 26 },
  notificationDot: {
    position: 'absolute',
    top: 10,
    right: 9,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    backgroundColor: colors.blue,
  },
  bottomContent: {
    flexShrink: 0,
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 15,
    backgroundColor: colors.background,
  },
  trackerCard: {
    minHeight: 180,
    borderRadius: 27,
    overflow: 'hidden',
  },
  trackerCardGradient: {
    flex: 1,
    minHeight: 180,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  trackerArtwork: {
    flex: 1.08,
    height: 143,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackerArtworkImage: { width: '116%', height: '100%' },
  trackerCopy: { flex: 0.92, minWidth: 0, paddingRight: 31 },
  trackerName: { color: '#FFFFFF', fontSize: 20, lineHeight: 24, fontWeight: '800' },
  trackerStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 7 },
  trackerStatusDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#2D83FF' },
  trackerStatusText: { color: '#2D83FF', fontSize: 13, lineHeight: 17, fontWeight: '600' },
  trackerLabel: { color: 'rgba(255,255,255,0.62)', fontSize: 11, lineHeight: 15, marginTop: 17 },
  trackerTime: { color: '#FFFFFF', fontSize: 19, lineHeight: 23, fontWeight: '800', marginTop: 2 },
  trackerMeta: { color: 'rgba(255,255,255,0.68)', fontSize: 13, lineHeight: 18, marginTop: 1 },
  trackerChevron: {
    position: 'absolute',
    right: 14,
    top: 64,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(83,130,193,0.28)',
  },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
});
