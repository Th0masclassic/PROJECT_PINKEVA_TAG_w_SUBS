import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppSafeArea, TrackerArtwork } from '../components';
import { formatRelativeTime, useI18n } from '../i18n';
import { MapBackdrop } from '../MapBackdrop';
import type { Tracker } from '../model';
import { colors, radii, shadow } from '../theme';

const pinPositions = [
  { left: '55%', top: '34%' },
  { left: '34%', top: '50%' },
  { right: '18%', top: '59%' },
  { left: '72%', top: '43%' },
] as const;

export function MapScreen({
  trackers,
  onOpenTracker,
  onShowTrackers,
  onNotice,
}: {
  trackers: Tracker[];
  onOpenTracker: (trackerId: string) => void;
  onShowTrackers: () => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const mapTrackers = trackers;

  return (
    <AppSafeArea style={styles.safeArea}>
      <View style={styles.container} testID="map-screen">
        <MapBackdrop style={styles.mapImage} />
        <View style={styles.mapWash} pointerEvents="none" />

        <View style={styles.searchRow}>
          <View style={[styles.searchBox, shadow]}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.mapMenu')} onPress={() => onNotice(t('map.menuOpened'))} style={styles.searchIconButton}>
              <Ionicons name="menu" size={28} color={colors.mutedDark} />
            </Pressable>
            <TextInput
              accessibilityLabel={t('a11y.searchTracker')}
              placeholder={t('map.searchPlaceholder')}
              placeholderTextColor={colors.muted}
              returnKeyType="search"
              onSubmitEditing={({ nativeEvent }) =>
                onNotice(nativeEvent.text ? t('map.showingResults', { query: nativeEvent.text }) : t('map.enterTrackerName'))
              }
              style={styles.searchInput}
            />
            <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.voiceSearch')} onPress={() => onNotice(t('map.voiceReady'))} style={styles.searchIconButton}>
              <Ionicons name="mic" size={25} color={colors.mutedDark} />
            </Pressable>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.openProfile')} onPress={() => onNotice(t('map.profileOpened'))} style={[styles.roundControl, shadow]}>
            <Ionicons name="person-circle-outline" size={35} color={colors.mutedDark} />
          </Pressable>
        </View>

        <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.changeMapLayers')} onPress={() => onNotice(t('map.layerChanged'))} style={[styles.layersButton, styles.roundControl, shadow]}>
          <Ionicons name="layers-outline" size={29} color={colors.mutedDark} />
        </Pressable>

        {mapTrackers.slice(0, pinPositions.length).map((tracker, index) => {
          const linkedTrackerId = resolveMapTrackerId(tracker, trackers);
          return (
            <MapPin
              key={tracker.id}
              tracker={tracker}
              position={pinPositions[index] ?? pinPositions[0]}
              onPress={linkedTrackerId ? () => onOpenTracker(linkedTrackerId) : undefined}
            />
          );
        })}

        <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.recenterMap')} onPress={() => onNotice(t('map.recentered'))} style={[styles.recenterButton, styles.roundControl, shadow]}>
          <Ionicons name="navigate" size={28} color={colors.blue} />
        </Pressable>

        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('map.myTags')}</Text>
            <Pressable accessibilityRole="button" onPress={onShowTrackers} style={styles.viewAllButton}>
              <Text style={styles.viewAllText}>{t('common.viewAll')}</Text>
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetList}>
            {mapTrackers.length ? mapTrackers.slice(0, 4).map((tracker) => {
              const linkedTrackerId = resolveMapTrackerId(tracker, trackers);
              return (
                <Pressable
                  key={tracker.id}
                  accessibilityRole={linkedTrackerId ? 'button' : 'text'}
                  accessibilityLabel={
                    linkedTrackerId
                      ? t('a11y.openTracker', { name: tracker.name })
                      : t('a11y.locationSample', { name: tracker.name })
                  }
                  disabled={!linkedTrackerId}
                  onPress={() => linkedTrackerId && onOpenTracker(linkedTrackerId)}
                  style={({ pressed }) => [styles.mapListRow, pressed && styles.pressed]}
                >
                  <View style={styles.mapThumb}>
                    <TrackerArtwork kind={tracker.kind} style={styles.mapThumbImage} decorative carIconSize={34} />
                  </View>
                  <View style={styles.mapListCopy}>
                    <Text style={styles.mapListTitle}>{tracker.name}</Text>
                    <Text style={styles.mapListAddress} numberOfLines={1}>{tracker.address}</Text>
                    <Text style={styles.mapListTime}>{formatRelativeTime(t, tracker.lastSeen)}</Text>
                  </View>
                  {linkedTrackerId ? <Ionicons name="chevron-forward" size={23} color={colors.muted} /> : null}
                </Pressable>
              );
            }) : <Text style={styles.emptyText}>{t('trackers.emptyBody')}</Text>}
          </ScrollView>
        </View>
      </View>
    </AppSafeArea>
  );
}

function resolveMapTrackerId(tracker: Tracker, accountTrackers: Tracker[]): string | undefined {
  return accountTrackers.some((candidate) => candidate.id === tracker.id) ? tracker.id : undefined;
}

function MapPin({
  tracker,
  position,
  onPress,
}: {
  tracker: Tracker;
  position: { left?: `${number}%`; right?: `${number}%`; top: `${number}%` };
  onPress?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'image'}
      accessibilityLabel={
        onPress
          ? t('a11y.openTrackerFromMap', { name: tracker.name })
          : t('a11y.mapMarker', { name: tracker.name })
      }
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.pinWrap, position, pressed && styles.pressed]}
    >
      <View style={styles.pinBadge}>
        <TrackerArtwork kind={tracker.kind} style={styles.pinImage} decorative carIconSize={26} />
      </View>
      <View style={styles.pinPoint} />
      <Text style={styles.pinLabel}>{tracker.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.mapWater },
  container: { flex: 1, overflow: 'hidden' },
  mapImage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  mapWash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(228,243,255,0.16)' },
  searchRow: { position: 'absolute', top: 18, left: 18, right: 18, flexDirection: 'row', gap: 12, alignItems: 'center' },
  searchBox: { flex: 1, minHeight: 58, borderRadius: 29, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5 },
  searchIconButton: { width: 46, height: 48, alignItems: 'center', justifyContent: 'center' },
  searchInput: { flex: 1, minHeight: 54, color: colors.text, fontSize: 16, outlineStyle: 'none' } as never,
  roundControl: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  layersButton: { position: 'absolute', right: 22, top: 94 },
  recenterButton: { position: 'absolute', right: 22, bottom: '43%' },
  pinWrap: { position: 'absolute', alignItems: 'center', width: 92, marginLeft: -46 },
  pinBadge: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.navy, borderWidth: 3, borderColor: '#FFFFFF', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', ...shadow },
  pinImage: { width: 45, height: 40 },
  pinPoint: { width: 13, height: 13, backgroundColor: colors.navy, transform: [{ rotate: '45deg' }], marginTop: -8, zIndex: -1 },
  pinLabel: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 3, textShadowColor: '#FFFFFF', textShadowRadius: 4 },
  bottomSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '41%', minHeight: 300, backgroundColor: '#FFFFFF', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingTop: 20, ...shadow },
  sheetHandle: { width: 48, height: 5, borderRadius: 3, backgroundColor: '#D0D4DF', alignSelf: 'center', marginBottom: 10 },
  sheetHeader: { minHeight: 48, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.text, fontSize: 23, fontWeight: '800' },
  viewAllButton: { minHeight: 44, paddingLeft: 16, justifyContent: 'center' },
  viewAllText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  sheetList: { paddingHorizontal: 18, paddingBottom: 20 },
  emptyText: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: 20, paddingTop: 28 },
  mapListRow: { minHeight: 83, flexDirection: 'row', alignItems: 'center', gap: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  mapThumb: { width: 62, height: 58, borderRadius: radii.small, backgroundColor: '#F7F9FC', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  mapThumbImage: { width: 58, height: 50 },
  mapListCopy: { flex: 1 },
  mapListTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  mapListAddress: { color: colors.muted, fontSize: 12, marginTop: 3 },
  mapListTime: { color: colors.blue, fontSize: 12, fontWeight: '600', marginTop: 3 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.985 }] },
});
