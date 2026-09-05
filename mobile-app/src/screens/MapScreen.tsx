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
  View,
  useWindowDimensions,
} from 'react-native';

import {
  interpolateCloudPlusCopy,
  useCloudPlusCopy,
} from '../billing/cloudPlusCopy';
import { AppSafeArea, TrackerArtwork } from '../components';
import { useI18n } from '../i18n';
import type {
  DeviceLocationHistory,
  DeviceLocationReport,
  LocationHistoryRange,
} from '../location/api';
import { createTrackerLocationPresentation } from '../location/presentation';
import { useResolvedTrackerLocations } from '../location/useResolvedTrackerLocations';
import { useLocationPresentationNow } from '../location/useLocationPresentationNow';
import { useUserLocation } from '../location/useUserLocation';
import { GoogleTrackerMap } from '../maps/GoogleTrackerMap';
import type { Tracker } from '../model';
import type { DeviceSafeZone, PremiumFeatureAccess } from '../premium/api';
import { canUseSafeZones } from '../premium/entitlements';
import { colors, radii, shadow } from '../theme';

const LONG_PRESS_DURATION_MS = 3000;

export function MapScreen({
  trackers,
  premiumFeatures,
  safeZones,
  requestedHistoryTrackerId,
  onHistoryRequestHandled,
  onRequestTrackerLocation,
  onRequestTrackerHistory,
  onShowTrackers,
  onOpenTracker,
  onNotice,
}: {
  trackers: Tracker[];
  premiumFeatures: Record<string, PremiumFeatureAccess>;
  safeZones: Record<string, DeviceSafeZone[]>;
  requestedHistoryTrackerId?: string;
  onHistoryRequestHandled: () => void;
  onRequestTrackerLocation: (trackerId: string) => Promise<DeviceLocationReport>;
  onRequestTrackerHistory: (
    trackerId: string,
    range: LocationHistoryRange,
  ) => Promise<DeviceLocationHistory>;
  onShowTrackers: () => void;
  onOpenTracker: (trackerId: string) => void;
  onNotice: (message: string) => void;
}) {
  const { language, t } = useI18n();
  const cloudCopy = useCloudPlusCopy();
  const mapTrackers = trackers;
  const userCoordinate = useUserLocation(trackers.length > 0);
  const locationNow = useLocationPresentationNow();
  const resolvedLocations = useResolvedTrackerLocations(trackers);
  const locationPresentations = useMemo(
    () => Object.fromEntries(mapTrackers.map((tracker) => [
      tracker.id,
      createTrackerLocationPresentation({
        tracker,
        language,
        t,
        userCoordinate,
        resolvedAddress: resolvedLocations[tracker.id],
        now: locationNow,
        safeZones: canUseSafeZones(premiumFeatures[tracker.id]) ? safeZones[tracker.id] : [],
      }),
    ])),
    [language, locationNow, mapTrackers, premiumFeatures, resolvedLocations, safeZones, t, userCoordinate],
  );
  const { height: windowHeight } = useWindowDimensions();
  const [mapType, setMapType] = useState<'standard' | 'satellite'>('standard');
  const [recenterToken, setRecenterToken] = useState(0);
  const [focusedTrackerId, setFocusedTrackerId] = useState<string | null>(null);
  const [historyTrackerId, setHistoryTrackerId] = useState<string | null>(null);
  const [historyRange, setHistoryRange] = useState<LocationHistoryRange>('24h');
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
  const canUseHistory = useCallback((trackerId: string, range: LocationHistoryRange = '24h') => {
    const access = premiumFeatures[trackerId];
    return Boolean(
      access?.subscriptionActive &&
      access.locationHistoryDays >= (range === '30d' ? 30 : 1),
    );
  }, [premiumFeatures]);
  const hasHistoryAccess = useMemo(
    () => mapTrackers.some((tracker) => canUseHistory(tracker.id)),
    [canUseHistory, mapTrackers],
  );

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
    if (!canUseHistory(trackerId)) return;
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
  }, [canUseHistory]);

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

  const showTrackerHistory = useCallback(async (
    trackerId: string,
    range: LocationHistoryRange = historyRange,
  ) => {
    if (!canUseHistory(trackerId, range)) {
      stopHoldCountdown();
      onNotice(cloudCopy.historyLocked);
      return;
    }
    locationRequestSequence.current += 1;
    setLocationLoadingId(null);
    stopHoldCountdown();
    const sequence = ++historyRequestSequence.current;
    setFocusedTrackerId(trackerId);
    setHistoryTrackerId(trackerId);
    setHistoryRange(range);
    setHistoryPoints([]);
    setHistoryLoadingId(trackerId);
    try {
      const history = await onRequestTrackerHistory(trackerId, range);
      if (historyRequestSequence.current !== sequence) return;
      setHistoryPoints(history.points);
      setRecenterToken((current) => current + 1);
      const rangeLabel = range === '30d' ? cloudCopy.history30d : cloudCopy.history24h;
      onNotice(
        history.points.length
          ? interpolateCloudPlusCopy(cloudCopy.historyReady, {
              count: String(history.points.length),
              range: rangeLabel,
            })
          : interpolateCloudPlusCopy(cloudCopy.historyEmpty, { range: rangeLabel }),
      );
      settleSheet(collapsedSheetOffset);
    } catch {
      if (historyRequestSequence.current !== sequence) return;
      onNotice(interpolateCloudPlusCopy(cloudCopy.historyError, {
        range: range === '30d' ? cloudCopy.history30d : cloudCopy.history24h,
      }));
    } finally {
      if (historyRequestSequence.current === sequence) setHistoryLoadingId(null);
    }
  }, [
    cloudCopy,
    canUseHistory,
    collapsedSheetOffset,
    historyRange,
    onNotice,
    onRequestTrackerHistory,
    settleSheet,
    stopHoldCountdown,
  ]);

  const handleRowLongPress = useCallback((trackerId: string) => {
    stopHoldCountdown();
    if (!canUseHistory(trackerId)) {
      onNotice(cloudCopy.historyLocked);
      return;
    }
    rowLongPressId.current = trackerId;
    if (rowLongPressTimer.current) clearTimeout(rowLongPressTimer.current);
    rowLongPressTimer.current = setTimeout(() => {
      if (rowLongPressId.current === trackerId) rowLongPressId.current = null;
    }, 1000);
    void showTrackerHistory(trackerId);
  }, [canUseHistory, cloudCopy.historyLocked, onNotice, showTrackerHistory, stopHoldCountdown]);

  const requestAndFocusTracker = useCallback(async (trackerId: string) => {
    stopHoldCountdown();
    if (rowLongPressId.current === trackerId) {
      rowLongPressId.current = null;
      return;
    }
    historyRequestSequence.current += 1;
    setHistoryLoadingId(null);
    setFocusedTrackerId(trackerId);
    setHistoryTrackerId(null);
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

  useEffect(() => {
    if (!requestedHistoryTrackerId) return;
    onHistoryRequestHandled();
    if (!canUseHistory(requestedHistoryTrackerId)) {
      setFocusedTrackerId(requestedHistoryTrackerId);
      setHistoryTrackerId(null);
      setHistoryPoints([]);
      setRecenterToken((current) => current + 1);
      onNotice(cloudCopy.historyLocked);
      return;
    }
    void showTrackerHistory(requestedHistoryTrackerId, '24h');
  }, [
    cloudCopy.historyLocked,
    canUseHistory,
    onHistoryRequestHandled,
    onNotice,
    requestedHistoryTrackerId,
    showTrackerHistory,
  ]);

  const closeHistory = useCallback(() => {
    historyRequestSequence.current += 1;
    setHistoryLoadingId(null);
    setHistoryTrackerId(null);
    setHistoryPoints([]);
    setRecenterToken((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!historyTrackerId || canUseHistory(historyTrackerId, historyRange)) return;
    closeHistory();
    stopHoldCountdown();
  }, [canUseHistory, closeHistory, historyRange, historyTrackerId, stopHoldCountdown]);

  const displayedMapTrackers = useMemo(() => {
    if (!historyTrackerId || !canUseHistory(historyTrackerId, historyRange) || historyPoints.length === 0) return mapTrackers;
    const tracker = mapTrackers.find((candidate) => candidate.id === historyTrackerId);
    const latestPoint = historyPoints[historyPoints.length - 1];
    if (!tracker || !latestPoint) return mapTrackers;
    return [{
      ...tracker,
      latitude: latestPoint.latitude,
      longitude: latestPoint.longitude,
    }];
  }, [canUseHistory, historyPoints, historyRange, historyTrackerId, mapTrackers]);
  const focusedTracker = focusedTrackerId
    ? mapTrackers.find((tracker) => tracker.id === focusedTrackerId)
    : undefined;
  const markerDescriptions = useMemo(
    () => Object.fromEntries(mapTrackers.map((tracker) => {
      const presentation = locationPresentations[tracker.id];
      return [tracker.id, presentation
        ? [presentation.primary, presentation.secondary, presentation.freshness].filter(Boolean).join('\n')
        : undefined];
    })),
    [locationPresentations, mapTrackers],
  );

  return (
    <AppSafeArea style={styles.safeArea}>
      <View style={styles.container} testID="map-screen">
        <GoogleTrackerMap
          trackers={displayedMapTrackers}
          mapType={mapType}
          recenterToken={recenterToken}
          focusTrackerId={focusedTrackerId ?? historyTrackerId ?? undefined}
          showsUserLocation={Boolean(userCoordinate)}
          markerDescriptions={markerDescriptions}
          pathCoordinates={
            historyTrackerId && canUseHistory(historyTrackerId, historyRange)
              ? historyPoints
              : []
          }
          onPressInTracker={startHoldCountdown}
          onPressOutTracker={stopHoldCountdown}
          onLongPressTracker={handleRowLongPress}
          onOpenTracker={(trackerId) => void requestAndFocusTracker(trackerId)}
        />
        <View style={styles.mapWash} pointerEvents="none" />

        {historyTrackerId && canUseHistory(historyTrackerId, historyRange) ? (
          <View style={[styles.historyPanel, shadow]} testID="map-history-filter">
            <View style={styles.historyPanelHeader}>
              <View style={styles.historyPanelTitleRow}>
                <Ionicons name="time-outline" size={19} color={colors.blue} />
                <Text style={styles.historyPanelTitle}>{cloudCopy.historyRangeTitle}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
                onPress={closeHistory}
                style={styles.historyCloseButton}
              >
                <Ionicons name="close" size={20} color={colors.mutedDark} />
              </Pressable>
            </View>
            <View style={styles.historySegments}>
              {(['24h', '30d'] as const).map((range) => {
                const selected = historyRange === range;
                const label = range === '30d' ? cloudCopy.history30d : cloudCopy.history24h;
                return (
                  <Pressable
                    key={range}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (!selected) void showTrackerHistory(historyTrackerId, range);
                    }}
                    style={[styles.historySegment, selected && styles.historySegmentSelected]}
                    testID={`map-history-${range}`}
                  >
                    <Text style={[
                      styles.historySegmentText,
                      selected && styles.historySegmentTextSelected,
                    ]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : hasHistoryAccess ? (
          <View pointerEvents="none" style={[styles.historyHint, shadow]}>
            <Ionicons name="sparkles" size={17} color={colors.blue} />
            <Text numberOfLines={3} style={styles.historyHintText}>{cloudCopy.historyHint}</Text>
          </View>
        ) : null}

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
              <Text style={styles.holdCountdownText}>
                {cloudCopy.historyCountdown} · {holdCountdown.seconds}
              </Text>
            </View>
          </View>
        ) : null}

        {historyLoadingId || locationLoadingId ? (
          <View style={[
            styles.historyLoading,
            historyTrackerId && styles.historyLoadingWithPanel,
            shadow,
          ]}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.historyLoadingText}>
              {historyLoadingId
                ? interpolateCloudPlusCopy(cloudCopy.historyLoading, {
                    name: mapTrackers.find((tracker) => tracker.id === historyLoadingId)?.name ?? t('common.tracker'),
                    range: historyRange === '30d' ? cloudCopy.history30d : cloudCopy.history24h,
                  })
                : t('map.locationLoading', {
                    name: mapTrackers.find((tracker) => tracker.id === locationLoadingId)?.name ?? t('common.tracker'),
                  })}
            </Text>
          </View>
        ) : null}

        {focusedTracker && !historyTrackerId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('a11y.openTracker', { name: focusedTracker.name })}
            onPress={() => onOpenTracker(focusedTracker.id)}
            style={({ pressed }) => [styles.focusedCard, shadow, pressed && styles.pressed]}
            testID="map-focused-tracker"
          >
            <View style={styles.focusedIcon}>
              <Ionicons
                name={locationPresentations[focusedTracker.id]?.safeZoneName ? 'shield-checkmark' : 'location'}
                size={23}
                color={colors.blue}
              />
            </View>
            <View style={styles.focusedCopy}>
              <Text numberOfLines={1} style={styles.focusedName}>{focusedTracker.name}</Text>
              <Text numberOfLines={1} style={styles.focusedPrimary}>
                {locationPresentations[focusedTracker.id]?.primary}
              </Text>
              {locationPresentations[focusedTracker.id]?.secondary ? (
                <Text numberOfLines={1} style={styles.focusedSecondary}>
                  {locationPresentations[focusedTracker.id]?.secondary}
                </Text>
              ) : null}
              {locationPresentations[focusedTracker.id]?.freshness ? (
                <Text numberOfLines={1} style={styles.focusedFreshness}>
                  {locationPresentations[focusedTracker.id]?.freshness}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={23} color={colors.muted} />
          </Pressable>
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
              const location = locationPresentations[tracker.id];
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
                    <Text style={styles.mapListPrimary} numberOfLines={1}>{location?.primary}</Text>
                    {location?.secondary ? (
                      <Text style={styles.mapListAddress} numberOfLines={1}>{location.secondary}</Text>
                    ) : null}
                    {location?.freshness ? (
                      <Text style={styles.mapListTime} numberOfLines={1}>{location.freshness}</Text>
                    ) : null}
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
  roundControl: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  layersButton: { position: 'absolute', right: 22, top: 18 },
  recenterButton: { position: 'absolute', right: 22, bottom: '43%' },
  historyHint: { position: 'absolute', top: 18, left: 18, right: 90, minHeight: 62, borderRadius: 19, backgroundColor: '#FFFFFF', paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 9 },
  historyHintText: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  historyPanel: { position: 'absolute', top: 18, left: 18, right: 90, borderRadius: 20, backgroundColor: '#FFFFFF', padding: 10, gap: 8 },
  historyPanelHeader: { minHeight: 30, paddingLeft: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  historyPanelTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  historyPanelTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '800' },
  historyCloseButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F1F4F9', alignItems: 'center', justifyContent: 'center' },
  historySegments: { minHeight: 38, padding: 3, borderRadius: 13, backgroundColor: '#EEF2F8', flexDirection: 'row', gap: 3 },
  historySegment: { flex: 1, minHeight: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  historySegmentSelected: { backgroundColor: colors.blue },
  historySegmentText: { color: colors.mutedDark, fontSize: 12, fontWeight: '800' },
  historySegmentTextSelected: { color: '#FFFFFF' },
  holdCountdownLayer: { position: 'absolute', top: 90, left: 80, right: 80, alignItems: 'center' },
  holdCountdown: { minHeight: 38, borderRadius: 19, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(7,21,53,0.90)' },
  holdCountdownText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  historyLoading: { position: 'absolute', top: 90, left: 28, right: 28, minHeight: 52, borderRadius: 18, backgroundColor: '#FFFFFF', paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  historyLoadingWithPanel: { top: 132 },
  historyLoadingText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  focusedCard: { position: 'absolute', left: 16, right: 16, bottom: 104, minHeight: 104, borderRadius: 22, backgroundColor: '#FFFFFF', padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  focusedIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  focusedCopy: { flex: 1, minWidth: 0 },
  focusedName: { color: colors.text, fontSize: 17, lineHeight: 21, fontWeight: '800' },
  focusedPrimary: { color: colors.blueDark, fontSize: 13, lineHeight: 18, fontWeight: '800', marginTop: 2 },
  focusedSecondary: { color: colors.mutedDark, fontSize: 12, lineHeight: 17, marginTop: 1 },
  focusedFreshness: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
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
  mapListPrimary: { color: colors.blueDark, fontSize: 12, fontWeight: '700', marginTop: 3 },
  mapListAddress: { color: colors.muted, fontSize: 12, marginTop: 3 },
  mapListTime: { color: colors.blue, fontSize: 12, fontWeight: '600', marginTop: 3 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.985 }] },
});
