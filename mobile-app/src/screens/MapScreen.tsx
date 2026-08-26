import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { AppSafeArea, TrackerArtwork } from '../components';
import { formatRelativeTime, useI18n } from '../i18n';
import type { DeviceLocationHistory, DeviceLocationReport } from '../location/api';
import { GoogleTrackerMap } from '../maps/GoogleTrackerMap';
import type { Tracker } from '../model';
import { colors, radii, shadow } from '../theme';

const LONG_PRESS_DURATION_MS = 3000;

export function MapScreen({
  trackers,
  requestedHistoryTrackerId,
  onHistoryRequestHandled,
  onRequestTrackerLocation,
  onRequestTrackerHistory,
  onShowTrackers,
  onNotice,
}: {
  trackers: Tracker[];
  requestedHistoryTrackerId?: string;
  onHistoryRequestHandled: () => void;
  onRequestTrackerLocation: (trackerId: string) => Promise<DeviceLocationReport>;
  onRequestTrackerHistory: (trackerId: string) => Promise<DeviceLocationHistory>;
  onShowTrackers: () => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const mapTrackers = trackers;
  const { height: windowHeight } = useWindowDimensions();
  const [mapType, setMapType] = useState<'standard' | 'satellite'>('standard');
  const [recenterToken, setRecenterToken] = useState(0);
  const [historyTrackerId, setHistoryTrackerId] = useState<string | null>(null);
  const [historyPoints, setHistoryPoints] = useState<DeviceLocationHistory['points']>([]);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [locationLoadingId, setLocationLoadingId] = useState<string | null>(null);
  const [holdCountdown, setHoldCountdown] = useState<{
    trackerId: string;
    seconds: number;
  } | null>(null);
  const historyRequestSequence = useRef(0);
  const locationRequestSequence = useRef(0);
  const holdCountdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const rowLongPressId = useRef<string | null>(null);
  const rowLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetHeight = Math.max(300, windowHeight * 0.41);
  const collapsedSheetOffset = Math.max(0, sheetHeight - 94);
  const sheetTranslateY = useRef(new Animated.Value(0)).current;
  const sheetGestureStart = useRef(0);
  const sheetRestingOffset = useRef(0);

  useEffect(() => {
    return () => {
      historyRequestSequence.current += 1;
      locationRequestSequence.current += 1;
      if (holdCountdownTimer.current) clearInterval(holdCountdownTimer.current);
      if (rowLongPressTimer.current) clearTimeout(rowLongPressTimer.current);
    };
  }, []);

  useEffect(() => {
    if (sheetRestingOffset.current === 0) return;
    sheetRestingOffset.current = collapsedSheetOffset;
    sheetTranslateY.setValue(collapsedSheetOffset);
  }, [collapsedSheetOffset, sheetTranslateY]);

  const settleSheet = useCallback((offset: number) => {
    sheetRestingOffset.current = offset;
    Animated.spring(sheetTranslateY, {
      toValue: offset,
      damping: 22,
      stiffness: 220,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [sheetTranslateY]);

  const stopHoldCountdown = useCallback(() => {
    if (holdCountdownTimer.current) {
      clearInterval(holdCountdownTimer.current);
      holdCountdownTimer.current = null;
    }
    setHoldCountdown(null);
  }, []);

  const startHoldCountdown = useCallback((trackerId: string) => {
    if (holdCountdownTimer.current) clearInterval(holdCountdownTimer.current);
    const deadline = Date.now() + LONG_PRESS_DURATION_MS;
    setHoldCountdown({ trackerId, seconds: 3 });
    holdCountdownTimer.current = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (holdCountdownTimer.current) clearInterval(holdCountdownTimer.current);
        holdCountdownTimer.current = null;
        setHoldCountdown((current) =>
          current?.trackerId === trackerId ? { trackerId, seconds: 1 } : current,
        );
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      setHoldCountdown((current) =>
        current?.trackerId === trackerId && current.seconds !== seconds
          ? { trackerId, seconds }
          : current,
      );
    }, 100);
  }, []);

  const sheetPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          Math.abs(gesture.dy) > 5 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          sheetTranslateY.stopAnimation((value) => {
            sheetGestureStart.current = value;
          });
        },
        onPanResponderMove: (_, gesture) => {
          sheetTranslateY.setValue(
            Math.max(0, Math.min(collapsedSheetOffset, sheetGestureStart.current + gesture.dy)),
          );
        },
        onPanResponderRelease: (_, gesture) => {
          const projected = sheetGestureStart.current + gesture.dy + gesture.vy * 80;
          settleSheet(projected > collapsedSheetOffset / 2 ? collapsedSheetOffset : 0);
        },
        onPanResponderTerminate: () => settleSheet(sheetRestingOffset.current),
      }),
    [collapsedSheetOffset, settleSheet, sheetTranslateY],
  );

  const showTrackerHistory = useCallback(async (trackerId: string) => {
    locationRequestSequence.current += 1;
    setLocationLoadingId(null);
    stopHoldCountdown();
    const sequence = ++historyRequestSequence.current;
    setHistoryLoadingId(trackerId);
    try {
      const history = await onRequestTrackerHistory(trackerId);
      if (historyRequestSequence.current !== sequence) return;
      setHistoryTrackerId(trackerId);
      setHistoryPoints(history.points);
      setRecenterToken((current) => current + 1);
      onNotice(
        history.points.length
          ? t('map.historyReady', { count: history.points.length })
          : t('map.historyEmpty'),
      );
      settleSheet(collapsedSheetOffset);
    } catch {
      if (historyRequestSequence.current !== sequence) return;
      onNotice(t('map.historyError'));
    } finally {
      if (historyRequestSequence.current === sequence) setHistoryLoadingId(null);
    }
  }, [collapsedSheetOffset, onNotice, onRequestTrackerHistory, settleSheet, stopHoldCountdown, t]);

  useEffect(() => {
    if (!requestedHistoryTrackerId) return;
    onHistoryRequestHandled();
    void showTrackerHistory(requestedHistoryTrackerId);
  }, [onHistoryRequestHandled, requestedHistoryTrackerId, showTrackerHistory]);

  const handleRowLongPress = useCallback((trackerId: string) => {
    stopHoldCountdown();
    rowLongPressId.current = trackerId;
    if (rowLongPressTimer.current) clearTimeout(rowLongPressTimer.current);
    rowLongPressTimer.current = setTimeout(() => {
      if (rowLongPressId.current === trackerId) rowLongPressId.current = null;
    }, 1000);
    void showTrackerHistory(trackerId);
  }, [showTrackerHistory, stopHoldCountdown]);

  const requestAndFocusTracker = useCallback(async (trackerId: string) => {
    stopHoldCountdown();
    if (rowLongPressId.current === trackerId) {
      rowLongPressId.current = null;
      return;
    }
    historyRequestSequence.current += 1;
    setHistoryLoadingId(null);
    setHistoryTrackerId(trackerId);
    setHistoryPoints([]);
    setRecenterToken((current) => current + 1);
    settleSheet(collapsedSheetOffset);

    const tracker = mapTrackers.find((candidate) => candidate.id === trackerId);
    if (tracker && hasTrackerCoordinate(tracker)) {
      onNotice(t('map.locationReady', { name: tracker.name }));
      return;
    }

    const sequence = ++locationRequestSequence.current;
    setLocationLoadingId(trackerId);
    try {
      const report = await onRequestTrackerLocation(trackerId);
      if (locationRequestSequence.current !== sequence) return;
      setRecenterToken((current) => current + 1);
      if (report.latitude !== null && report.longitude !== null) {
        onNotice(t('map.locationReady', {
          name: mapTrackers.find((tracker) => tracker.id === trackerId)?.name ?? t('common.tracker'),
        }));
      } else {
        onNotice(t('map.locationUnavailable'));
      }
    } catch {
      if (locationRequestSequence.current !== sequence) return;
      onNotice(t('map.locationError'));
    } finally {
      if (locationRequestSequence.current === sequence) setLocationLoadingId(null);
    }
  }, [collapsedSheetOffset, mapTrackers, onNotice, onRequestTrackerLocation, settleSheet, stopHoldCountdown, t]);

  const displayedMapTrackers = useMemo(() => {
    if (!historyTrackerId || historyPoints.length === 0) return mapTrackers;
    const tracker = mapTrackers.find((candidate) => candidate.id === historyTrackerId);
    const latestPoint = historyPoints[historyPoints.length - 1];
    if (!tracker || !latestPoint) return mapTrackers;
    return [{
      ...tracker,
      latitude: latestPoint.latitude,
      longitude: latestPoint.longitude,
    }];
  }, [historyPoints, historyTrackerId, mapTrackers]);

  return (
    <AppSafeArea style={styles.safeArea}>
      <View style={styles.container} testID="map-screen">
        <GoogleTrackerMap
          trackers={displayedMapTrackers}
          mapType={mapType}
          recenterToken={recenterToken}
          focusTrackerId={historyTrackerId ?? undefined}
          pathCoordinates={historyPoints}
          onPressInTracker={startHoldCountdown}
          onPressOutTracker={stopHoldCountdown}
          onLongPressTracker={handleRowLongPress}
          onOpenTracker={(trackerId) => void requestAndFocusTracker(trackerId)}
        />
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

        <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.changeMapLayers')} onPress={() => {
          setMapType((current) => current === 'standard' ? 'satellite' : 'standard');
          onNotice(t('map.layerChanged'));
        }} style={[styles.layersButton, styles.roundControl, shadow]}>
          <Ionicons name="layers-outline" size={29} color={colors.mutedDark} />
        </Pressable>

        <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.recenterMap')} onPress={() => {
          setRecenterToken((current) => current + 1);
          onNotice(t('map.recentered'));
        }} style={[styles.recenterButton, styles.roundControl, shadow]}>
          <Ionicons name="navigate" size={28} color={colors.blue} />
        </Pressable>

        {holdCountdown ? (
          <View pointerEvents="none" style={styles.holdCountdownLayer}>
            <View style={[styles.holdCountdown, shadow]} accessibilityLiveRegion="polite">
              <Ionicons name="time-outline" size={17} color="#FFFFFF" />
              <Text style={styles.holdCountdownText}>24h · {holdCountdown.seconds}</Text>
            </View>
          </View>
        ) : null}

        {historyLoadingId || locationLoadingId ? (
          <View style={[styles.historyLoading, shadow]}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.historyLoadingText}>
              {historyLoadingId
                ? t('map.historyLoading', {
                    name: mapTrackers.find((tracker) => tracker.id === historyLoadingId)?.name ?? t('common.tracker'),
                  })
                : t('map.locationLoading', {
                    name: mapTrackers.find((tracker) => tracker.id === locationLoadingId)?.name ?? t('common.tracker'),
                  })}
            </Text>
          </View>
        ) : null}

        <Animated.View
          style={[
            styles.bottomSheet,
            { height: sheetHeight, transform: [{ translateY: sheetTranslateY }] },
          ]}
        >
          <View style={styles.sheetGrabArea} {...sheetPanResponder.panHandlers}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('map.myTags')}
              onPress={() =>
                settleSheet(sheetRestingOffset.current === 0 ? collapsedSheetOffset : 0)
              }
              style={styles.sheetDragHandle}
            >
              <View style={styles.sheetHandle} />
            </Pressable>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{t('map.myTags')}</Text>
              <Pressable accessibilityRole="button" onPress={onShowTrackers} style={styles.viewAllButton}>
                <Text style={styles.viewAllText}>{t('common.viewAll')}</Text>
              </Pressable>
            </View>
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
                      ? t('a11y.locateTracker', { name: tracker.name })
                      : t('a11y.locationSample', { name: tracker.name })
                  }
                  disabled={!linkedTrackerId}
                  delayLongPress={3000}
                  onPressIn={() => linkedTrackerId && startHoldCountdown(linkedTrackerId)}
                  onPressOut={stopHoldCountdown}
                  onLongPress={() => linkedTrackerId && handleRowLongPress(linkedTrackerId)}
                  onPress={() => linkedTrackerId && void requestAndFocusTracker(linkedTrackerId)}
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
                  {linkedTrackerId ? (
                    locationLoadingId === linkedTrackerId
                      ? <ActivityIndicator size="small" color={colors.blue} />
                      : <Ionicons name="locate-outline" size={23} color={colors.blue} />
                  ) : null}
                </Pressable>
              );
            }) : <Text style={styles.emptyText}>{t('trackers.emptyBody')}</Text>}
          </ScrollView>
        </Animated.View>
      </View>
    </AppSafeArea>
  );
}

function resolveMapTrackerId(tracker: Tracker, accountTrackers: Tracker[]): string | undefined {
  return accountTrackers.some((candidate) => candidate.id === tracker.id) ? tracker.id : undefined;
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

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.mapWater },
  container: { flex: 1, overflow: 'hidden' },
  mapWash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(228,243,255,0.16)' },
  searchRow: { position: 'absolute', top: 18, left: 18, right: 18, flexDirection: 'row', gap: 12, alignItems: 'center' },
  searchBox: { flex: 1, minHeight: 58, borderRadius: 29, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5 },
  searchIconButton: { width: 46, height: 48, alignItems: 'center', justifyContent: 'center' },
  searchInput: { flex: 1, minHeight: 54, color: colors.text, fontSize: 16, outlineStyle: 'none' } as never,
  roundControl: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  layersButton: { position: 'absolute', right: 22, top: 94 },
  recenterButton: { position: 'absolute', right: 22, bottom: '43%' },
  holdCountdownLayer: { position: 'absolute', top: 91, left: 80, right: 80, alignItems: 'center' },
  holdCountdown: { minHeight: 38, borderRadius: 19, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(7,21,53,0.90)' },
  holdCountdownText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  historyLoading: { position: 'absolute', top: 164, left: 28, right: 28, minHeight: 52, borderRadius: 18, backgroundColor: '#FFFFFF', paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  historyLoadingText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  bottomSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingTop: 4, ...shadow },
  sheetGrabArea: { minHeight: 82 },
  sheetDragHandle: { height: 34, alignItems: 'center', justifyContent: 'center' },
  sheetHandle: { width: 48, height: 5, borderRadius: 3, backgroundColor: '#D0D4DF' },
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
