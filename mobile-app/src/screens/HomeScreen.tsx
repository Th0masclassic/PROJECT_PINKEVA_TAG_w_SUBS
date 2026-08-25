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
  Surface,
  TrackerRow,
} from '../components';
import { formatRelativeTime, localizeTrackerPlace, useI18n } from '../i18n';
import { selectClosestLocatedTracker } from '../location/nearestTracker';
import { useUserLocation } from '../location/useUserLocation';
import { GoogleTrackerMap } from '../maps/GoogleTrackerMap';
import type { Tracker } from '../model';
import { colors, radii, shadow } from '../theme';

export function HomeScreen({
  displayName,
  trackers,
  mainTracker,
  recentTrackers,
  onOpenMap,
  onOpenTracker,
  onShowTrackers,
  onAddTracker,
  onToggleLost,
  onNotice,
}: {
  displayName: string;
  trackers: Tracker[];
  mainTracker?: Tracker;
  recentTrackers: Tracker[];
  onOpenMap: () => void;
  onOpenTracker: (trackerId: string) => void;
  onShowTrackers: () => void;
  onAddTracker: () => void;
  onToggleLost: (trackerId: string) => void;
  onNotice: (message: string) => void;
}) {
  const { width } = useWindowDimensions();
  const { t } = useI18n();
  const twoColumn = width >= 390;
  const userCoordinate = useUserLocation(trackers.length > 0);
  const closestLocatedTracker = useMemo(
    () => selectClosestLocatedTracker(trackers, userCoordinate, mainTracker?.id),
    [mainTracker?.id, trackers, userCoordinate],
  );
  const focusedTracker = closestLocatedTracker ?? mainTracker ?? trackers[0];

  return (
    <AppSafeArea>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        testID="home-screen"
      >
        <View style={styles.topRow}>
          <Brand compact />
          <View>
            <IconButton
              name="notifications-outline"
              accessibilityLabel={t('a11y.notifications')}
              onPress={() => onNotice(t('home.notificationsClear'))}
            />
            <View style={styles.notificationDot} />
          </View>
        </View>

        <View style={styles.welcome}>
          <Text style={styles.welcomeSmall}>{t('home.welcomeBack')}</Text>
          <Text numberOfLines={1} style={styles.welcomeName}>{displayName}</Text>
          <Text style={styles.welcomeBody}>{t('home.summary')}</Text>
        </View>

        {trackers.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('a11y.openMap')}
            onPress={onOpenMap}
            style={({ pressed }) => [styles.heroMapCard, shadow, pressed && styles.pressed]}
            testID="home-map-card"
          >
            <View style={styles.heroMap} pointerEvents="none">
              <GoogleTrackerMap
                trackers={trackers}
                mapType="standard"
                recenterToken={0}
                focusTrackerId={focusedTracker?.id}
                showsUserLocation={Boolean(userCoordinate)}
                onOpenTracker={onOpenTracker}
              />
              <View style={styles.mapTint} />
            </View>
            {focusedTracker ? (
              <View style={styles.heroMapInfo} pointerEvents="none">
                <View style={styles.heroMapIcon}>
                  <Ionicons name="location" size={20} color="#FFFFFF" />
                </View>
                <View style={styles.heroMapCopy}>
                  <Text numberOfLines={1} style={styles.heroMapTitle}>{focusedTracker.name}</Text>
                  <Text numberOfLines={1} style={styles.heroMapMeta}>
                    {localizeTrackerPlace(t, focusedTracker.place)} · {formatRelativeTime(t, focusedTracker.lastSeen)}
                  </Text>
                </View>
              </View>
            ) : null}
            <View style={styles.navigateButton} pointerEvents="none">
              <Ionicons name="navigate" size={25} color={colors.blue} />
            </View>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('a11y.addTracker')}
            onPress={onAddTracker}
            style={({ pressed }) => [styles.noTrackerCard, shadow, pressed && styles.pressed]}
            testID="home-add-main-tracker"
          >
            <View style={styles.noTrackerIcon}>
              <Ionicons name="add" size={32} color="#FFFFFF" />
            </View>
            <View style={styles.noTrackerCopy}>
              <Text style={styles.noTrackerTitle}>{t('home.readyTitle')}</Text>
              <Text style={styles.noTrackerBody}>{t('home.readyBody')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={24} color={colors.blue} />
          </Pressable>
        )}

        {mainTracker ? (
          <View style={[styles.actionGrid, !twoColumn && styles.actionGridStacked]}>
            <ActionCard
              icon="shield-outline"
              title={mainTracker.isLost ? t('home.markedLost') : t('home.markLost')}
              body={mainTracker.isLost ? t('home.lostEnabledBody') : t('home.lostHelpBody')}
              onPress={() => onToggleLost(mainTracker.id)}
            />
            <ActionCard
              icon="time-outline"
              title={t('home.locationHistory')}
              body={t('home.locationHistoryBody')}
              onPress={() => onNotice(t('home.locationHistoryNotice'))}
            />
          </View>
        ) : null}

        <Surface style={styles.privacyCard}>
          <View style={styles.privacyIcon}>
            <Ionicons name="shield-checkmark-outline" color={colors.blue} size={33} />
          </View>
          <View style={styles.privacyCopy}>
            <Text style={styles.privacyTitle}>{t('home.privacyTitle')}</Text>
            <Text style={styles.privacyText}>{t('home.privacyBody')}</Text>
          </View>
          <View style={styles.worldDots}>
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <View key={row} style={styles.worldDotRow}>
                {[0, 1, 2, 3, 4, 5, 6].map((dot) => (
                  <View
                    key={dot}
                    style={[styles.worldDot, (row + dot) % 4 === 0 && styles.worldDotFaded]}
                  />
                ))}
              </View>
            ))}
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <View style={styles.sectionCopy}>
            <Text style={styles.sectionTitle}>{t('home.myTrackers')}</Text>
            <Text style={styles.sectionSubtitle}>{t('home.recentTrackersBody')}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onShowTrackers} style={styles.viewAllButton}>
            <Text style={styles.viewAll}>{t('common.viewAll')}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.blue} />
          </Pressable>
        </View>
        <Surface style={styles.trackerList}>
          {recentTrackers.length ? (
            recentTrackers.slice(0, 2).map((tracker, index) => (
              <View key={tracker.id}>
                <TrackerRow tracker={tracker} onPress={() => onOpenTracker(tracker.id)} compact />
                {index < recentTrackers.length - 1 ? <View style={styles.rowDivider} /> : null}
              </View>
            ))
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('a11y.addTracker')}
              onPress={onAddTracker}
              style={styles.emptyListButton}
              testID="home-add-recent-tracker"
            >
              <View style={styles.emptyPlus}>
                <Ionicons name="add" size={26} color="#FFFFFF" />
              </View>
              <View style={styles.emptyListCopy}>
                <Text style={styles.emptyListTitle}>{t('home.noRecentTitle')}</Text>
                <Text style={styles.emptyListBody}>
                  {mainTracker ? t('home.noRecentBody') : t('home.addFirstTracker')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={23} color={colors.blue} />
            </Pressable>
          )}
        </Surface>
      </ScrollView>
    </AppSafeArea>
  );
}

function ActionCard({
  icon,
  title,
  body,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.actionCard, shadow, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={31} color={colors.blue} />
      <View style={styles.actionCopy}>
        <View style={styles.actionTitleRow}>
          <Text style={styles.actionTitle}>{title}</Text>
          <Ionicons name="chevron-forward" size={20} color={colors.mutedDark} />
        </View>
        <Text style={styles.actionBody}>{body}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: 18, paddingBottom: 28, gap: 20 },
  topRow: { paddingTop: 10, paddingHorizontal: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  notificationDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue, right: 8, top: 7, borderWidth: 1.5, borderColor: colors.background },
  welcome: { paddingHorizontal: 6, gap: 2 },
  welcomeSmall: { color: colors.muted, fontSize: 19 },
  welcomeName: { color: colors.text, fontSize: 39, lineHeight: 43, fontWeight: '800', letterSpacing: -1.2 },
  welcomeBody: { color: colors.mutedDark, fontSize: 16, marginTop: 8 },
  heroMapCard: { minHeight: 292, borderRadius: radii.large, overflow: 'hidden', backgroundColor: colors.mapWater },
  heroMap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  heroMapInfo: { position: 'absolute', left: 14, right: 74, bottom: 14, minHeight: 62, borderRadius: 18, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.94)', ...shadow },
  heroMapIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  heroMapCopy: { flex: 1 },
  heroMapTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  heroMapMeta: { color: colors.mutedDark, fontSize: 12, marginTop: 3 },
  noTrackerCard: { minHeight: 148, padding: 22, flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#FFFFFF', borderRadius: radii.large },
  noTrackerIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  noTrackerCopy: { flex: 1 },
  noTrackerTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  noTrackerBody: { color: colors.muted, fontSize: 15, lineHeight: 21, marginTop: 6 },
  mapTint: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(232,242,255,0.20)' },
  navigateButton: { position: 'absolute', right: 14, bottom: 14, height: 52, width: 52, borderRadius: 18, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', ...shadow },
  actionGrid: { flexDirection: 'row', gap: 14 },
  actionGridStacked: { flexDirection: 'column' },
  actionCard: { flex: 1, minHeight: 140, backgroundColor: '#FFFFFF', borderRadius: radii.medium, padding: 17, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  actionCopy: { flex: 1 },
  actionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionTitle: { color: colors.text, fontSize: 17, fontWeight: '700', flex: 1 },
  actionBody: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7 },
  privacyCard: { minHeight: 98, padding: 16, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  privacyIcon: { width: 46 },
  privacyCopy: { flex: 1, zIndex: 2 },
  privacyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  privacyText: { color: colors.muted, fontSize: 13, marginTop: 4 },
  worldDots: { position: 'absolute', right: 12, opacity: 0.55, gap: 3 },
  worldDotRow: { flexDirection: 'row', gap: 3 },
  worldDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.blue },
  worldDotFaded: { opacity: 0 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, gap: 10 },
  sectionCopy: { flex: 1 },
  sectionTitle: { color: colors.text, fontSize: 21, fontWeight: '800' },
  sectionSubtitle: { color: colors.muted, fontSize: 12, marginTop: 3 },
  viewAllButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', paddingLeft: 8 },
  viewAll: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  trackerList: { overflow: 'hidden' },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 90 },
  emptyListButton: { minHeight: 104, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  emptyPlus: { width: 46, height: 46, borderRadius: 16, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  emptyListCopy: { flex: 1 },
  emptyListTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  emptyListBody: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.995 }] },
});
