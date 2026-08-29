import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import {
  AppSafeArea,
  Brand,
  IconButton,
  PrimaryButton,
  TextButton,
  TrackerArtwork,
} from '../components';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import { formatRelativeTime, localizeTrackerPlace, useI18n } from '../i18n';
import { selectClosestLocatedTracker } from '../location/nearestTracker';
import { useUserLocation } from '../location/useUserLocation';
import { GoogleTrackerMap } from '../maps/GoogleTrackerMap';
import type { Tracker } from '../model';
import { colors, radii, shadow } from '../theme';

export function HomeScreen({
  trackers,
  mainTracker,
  cloudPlusActive,
  onOpenTracker,
  onAddTracker,
  onOpenHistory,
  onToggleLost,
  onOpenCloudPlus,
  onOpenNotifications,
  unreadNotificationCount,
  onNotice,
}: {
  trackers: Tracker[];
  mainTracker?: Tracker;
  cloudPlusActive: boolean;
  onOpenTracker: (trackerId: string) => void;
  onAddTracker: () => void;
  onOpenHistory: (trackerId: string) => void;
  onToggleLost: (trackerId: string) => void;
  onOpenCloudPlus: (trackerId: string) => void;
  onOpenNotifications: () => void;
  unreadNotificationCount: number;
  onNotice: (message: string) => void;
}) {
  const { width } = useWindowDimensions();
  const { t } = useI18n();
  const cloudCopy = useCloudPlusCopy();
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

  return (
    <AppSafeArea style={styles.safeArea}>
      <View style={styles.container} testID="home-screen">
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

        <View style={styles.bottomContent} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('a11y.openTracker', { name: focusedTracker.name })}
            onPress={() => onOpenTracker(focusedTracker.id)}
            style={({ pressed }) => [styles.trackerCard, shadow, pressed && styles.pressed]}
            testID="home-closest-tracker"
          >
            <View style={styles.trackerArtwork}>
              <TrackerArtwork
                kind={focusedTracker.kind}
                style={styles.trackerArtworkImage}
                decorative
                carIconSize={34}
              />
            </View>
            <View style={styles.trackerCopy}>
              <Text style={styles.trackerLabel}>{t('home.lastSeen')}</Text>
              <Text numberOfLines={1} style={styles.trackerName}>{focusedTracker.name}</Text>
              <Text numberOfLines={1} style={styles.trackerMeta}>
                {localizeTrackerPlace(t, focusedTracker.place)} · {formatRelativeTime(t, focusedTracker.lastSeen)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={24} color={colors.mutedDark} />
          </Pressable>

          <View style={[styles.actionGrid, width < 360 && styles.actionGridStacked]}>
            <ActionCard
              icon={cloudPlusActive ? 'shield-outline' : 'lock-closed-outline'}
              title={focusedTracker.isLost ? t('home.markedLost') : t('home.markLost')}
              body={
                cloudPlusActive
                  ? focusedTracker.isLost
                    ? t('home.lostEnabledBody')
                    : t('home.lostHelpBody')
                  : cloudCopy.lostLocked
              }
              locked={!cloudPlusActive}
              onPress={() =>
                cloudPlusActive
                  ? onToggleLost(focusedTracker.id)
                  : onOpenCloudPlus(focusedTracker.id)
              }
            />
            <ActionCard
              icon={cloudPlusActive ? 'time-outline' : 'lock-closed-outline'}
              title={cloudCopy.historyTitle}
              body={cloudPlusActive ? cloudCopy.historyBody : cloudCopy.historyLocked}
              locked={!cloudPlusActive}
              onPress={() =>
                cloudPlusActive
                  ? onOpenHistory(focusedTracker.id)
                  : onOpenCloudPlus(focusedTracker.id)
              }
            />
          </View>
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
      icon: 'location-outline',
      title: t('trackers.learn'),
      body: t('trackers.learnNotice'),
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

function ActionCard({
  icon,
  title,
  body,
  locked = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  locked?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.actionCard, shadow, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={27} color={colors.blue} />
      <View style={styles.actionCopy}>
        <Text style={styles.actionTitle} numberOfLines={2}>{title}</Text>
        <Text style={styles.actionBody} numberOfLines={3}>{body}</Text>
      </View>
      {locked ? <Ionicons name="lock-closed" size={15} color={colors.muted} /> : null}
    </Pressable>
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
  container: { flex: 1, backgroundColor: colors.mapWater, overflow: 'hidden' },
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
    position: 'absolute',
    right: 18,
    bottom: 18,
    left: 18,
    gap: 12,
  },
  trackerCard: {
    minHeight: 84,
    padding: 11,
    paddingRight: 14,
    borderRadius: radii.large,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.97)',
  },
  trackerArtwork: {
    width: 61,
    height: 61,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#F1F5FF',
  },
  trackerArtworkImage: { width: 56, height: 48 },
  trackerCopy: { flex: 1, minWidth: 0 },
  trackerLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7 },
  trackerName: { color: colors.text, fontSize: 20, lineHeight: 24, fontWeight: '800', marginTop: 1 },
  trackerMeta: { color: colors.mutedDark, fontSize: 12, lineHeight: 17, marginTop: 2 },
  actionGrid: { flexDirection: 'row', gap: 12 },
  actionGridStacked: { flexDirection: 'column' },
  actionCard: {
    flex: 1,
    minHeight: 98,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: radii.medium,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.97)',
  },
  actionCopy: { flex: 1, minWidth: 0 },
  actionTitle: { color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: '800' },
  actionBody: { color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 3 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
});
