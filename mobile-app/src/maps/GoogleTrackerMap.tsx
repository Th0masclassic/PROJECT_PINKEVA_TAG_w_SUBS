import { Pressable, StyleSheet, View } from 'react-native';

import { MapBackdrop } from '../MapBackdrop';
import { TrackerArtwork } from '../components';
import type { Tracker } from '../model';

const EMPTY_PATH: { latitude: number; longitude: number }[] = [];

export function GoogleTrackerMap({
  trackers,
  mapType: _mapType,
  recenterToken: _recenterToken,
  focusTrackerId,
  showsUserLocation: _showsUserLocation = false,
  pathCoordinates: _pathCoordinates = EMPTY_PATH,
  markerDescriptions: _markerDescriptions = {},
  onPressInTracker,
  onPressOutTracker,
  onLongPressTracker,
  onOpenTracker,
}: {
  trackers: Tracker[];
  mapType: 'standard' | 'satellite';
  recenterToken: number;
  focusTrackerId?: string;
  showsUserLocation?: boolean;
  pathCoordinates?: { latitude: number; longitude: number }[];
  markerDescriptions?: Record<string, string | undefined>;
  onPressInTracker?: (trackerId: string) => void;
  onPressOutTracker?: () => void;
  onLongPressTracker?: (trackerId: string) => void;
  onOpenTracker: (trackerId: string) => void;
}) {
  const markers = projectMarkers(trackers, focusTrackerId);

  return (
    <View style={StyleSheet.absoluteFill} testID="google-map-web-fallback">
      <MapBackdrop style={StyleSheet.absoluteFill} />
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {markers.map(({ tracker, left, top }) => (
          <Pressable
            key={tracker.id}
            accessibilityRole="button"
            accessibilityLabel={`${tracker.name} map marker`}
            delayLongPress={3000}
            onPressIn={() => onPressInTracker?.(tracker.id)}
            onPressOut={onPressOutTracker}
            onLongPress={() => onLongPressTracker?.(tracker.id)}
            onPress={() => onOpenTracker(tracker.id)}
            style={[styles.marker, { left: `${left}%`, top: `${top}%` }]}
            testID={`map-marker-${tracker.id}`}
          >
            <View style={styles.markerBubble}>
              <TrackerArtwork
                kind={tracker.kind}
                style={styles.markerArtwork}
                decorative
                carIconSize={27}
              />
            </View>
            <View style={styles.markerTip} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

type ProjectedMarker = {
  tracker: Tracker;
  left: number;
  top: number;
};

function projectMarkers(trackers: Tracker[], focusTrackerId?: string): ProjectedMarker[] {
  const located = trackers.filter(
    (tracker): tracker is Tracker & { latitude: number; longitude: number } =>
      typeof tracker.latitude === 'number' && typeof tracker.longitude === 'number',
  );
  if (located.length === 0) return [];

  if (located.length === 1) {
    return [{ tracker: located[0], left: 50, top: 34 }];
  }

  const longitudes = located.map((tracker) => tracker.longitude);
  const latitudes = located.map((tracker) => tracker.latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const longitudeSpan = maxLongitude - minLongitude;
  const latitudeSpan = maxLatitude - minLatitude;

  const focused = located.find((tracker) => tracker.id === focusTrackerId);
  return located.map((tracker) => {
    if (focused) {
      return {
        tracker,
        left: Math.max(
          18,
          Math.min(
            82,
            50 + (longitudeSpan === 0 ? 0 : ((tracker.longitude - focused.longitude) / longitudeSpan) * 32),
          ),
        ),
        top: Math.max(
          16,
          Math.min(
            52,
            34 + (latitudeSpan === 0 ? 0 : ((focused.latitude - tracker.latitude) / latitudeSpan) * 18),
          ),
        ),
      };
    }

    return {
      tracker,
      left: longitudeSpan === 0
        ? 50
        : 18 + ((tracker.longitude - minLongitude) / longitudeSpan) * 64,
      // Keep markers above the bottom sheet in the decorative fallback map.
      top: latitudeSpan === 0
        ? 34
        : 16 + ((maxLatitude - tracker.latitude) / latitudeSpan) * 36,
    };
  });
}

const styles = StyleSheet.create({
  marker: {
    position: 'absolute',
    width: 58,
    height: 70,
    marginLeft: -29,
    marginTop: -35,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  markerBubble: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#0B57D0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#071C48',
    shadowOpacity: 0.22,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  markerArtwork: {
    width: 42,
    height: 34,
  },
  markerTip: {
    width: 0,
    height: 0,
    marginTop: -1,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#0B57D0',
  },
});
