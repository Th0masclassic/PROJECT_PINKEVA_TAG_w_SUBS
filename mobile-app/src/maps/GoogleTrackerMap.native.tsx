import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type LatLng, type MapType } from 'react-native-maps';

import { TrackerArtwork } from '../components';
import type { Tracker } from '../model';

const FALLBACK_REGION = {
  latitude: 38.7223,
  longitude: -9.1393,
  latitudeDelta: 0.18,
  longitudeDelta: 0.18,
};
const EMPTY_PATH: LatLng[] = [];

export function GoogleTrackerMap({
  trackers,
  mapType,
  recenterToken,
  focusTrackerId,
  showsUserLocation = false,
  pathCoordinates = EMPTY_PATH,
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
  pathCoordinates?: LatLng[];
  onPressInTracker?: (trackerId: string) => void;
  onPressOutTracker?: () => void;
  onLongPressTracker?: (trackerId: string) => void;
  onOpenTracker: (trackerId: string) => void;
}) {
  const ref = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const coordinates = useMemo(
    () =>
      trackers
        .filter(
          (tracker): tracker is Tracker & { latitude: number; longitude: number } =>
            typeof tracker.latitude === 'number' && typeof tracker.longitude === 'number',
        )
        .map((tracker) => ({
          tracker,
          coordinate: { latitude: tracker.latitude, longitude: tracker.longitude } satisfies LatLng,
        })),
    [trackers],
  );
  const focusedCoordinate = coordinates.find(
    ({ tracker }) => tracker.id === focusTrackerId,
  )?.coordinate;

  const fitMarkers = useCallback(() => {
    if (!ref.current) return;
    if (pathCoordinates.length > 1) {
      ref.current.fitToCoordinates(pathCoordinates, {
        edgePadding: { top: 160, right: 60, bottom: 180, left: 60 },
        animated: true,
      });
      return;
    }
    if (pathCoordinates.length === 1) {
      ref.current.animateToRegion(
        { ...pathCoordinates[0], latitudeDelta: 0.025, longitudeDelta: 0.025 },
        450,
      );
      return;
    }
    if (coordinates.length === 0) {
      ref.current.animateToRegion(FALLBACK_REGION, 450);
      return;
    }
    if (focusedCoordinate) {
      ref.current.animateToRegion(
        { ...focusedCoordinate, latitudeDelta: 0.028, longitudeDelta: 0.028 },
        450,
      );
      return;
    }
    if (coordinates.length === 1) {
      ref.current.animateToRegion(
        { ...coordinates[0].coordinate, latitudeDelta: 0.035, longitudeDelta: 0.035 },
        450,
      );
      return;
    }
    ref.current.fitToCoordinates(
      coordinates.map((entry) => entry.coordinate),
      { edgePadding: { top: 150, right: 60, bottom: 390, left: 60 }, animated: true },
    );
  }, [coordinates, focusedCoordinate, pathCoordinates]);

  useEffect(() => {
    if (mapReady) fitMarkers();
  }, [coordinates, fitMarkers, mapReady]);

  useEffect(() => {
    if (mapReady && recenterToken > 0) fitMarkers();
  }, [fitMarkers, mapReady, recenterToken]);

  const hasGoogleKey = Platform.select({
    ios: Boolean(process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY),
    android: Boolean(process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY),
    default: false,
  });

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={ref}
        provider={hasGoogleKey ? PROVIDER_GOOGLE : undefined}
        mapType={mapType as MapType}
        initialRegion={FALLBACK_REGION}
        rotateEnabled
        pitchEnabled
        showsCompass
        showsScale
        showsUserLocation={showsUserLocation}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        style={StyleSheet.absoluteFill}
        testID="google-tracker-map"
        onMapReady={() => {
          setMapReady(true);
          fitMarkers();
        }}
      >
        {pathCoordinates.length > 1 ? (
          <Polyline
            coordinates={pathCoordinates}
            strokeColor="#0B57D0"
            strokeWidth={5}
            lineCap="round"
            lineJoin="round"
          />
        ) : null}
        {coordinates.map(({ tracker, coordinate }) => (
          <Marker
            key={tracker.id}
            coordinate={coordinate}
            title={tracker.name}
            description={tracker.address === '—' ? tracker.place : tracker.address}
            anchor={{ x: 0.5, y: 1 }}
            centerOffset={{ x: 0, y: -4 }}
            onCalloutPress={() => onOpenTracker(tracker.id)}
          >
            <TrackerMapMarker
              tracker={tracker}
              onOpenTracker={onOpenTracker}
              onPressInTracker={onPressInTracker}
              onPressOutTracker={onPressOutTracker}
              onLongPressTracker={onLongPressTracker}
            />
          </Marker>
        ))}
      </MapView>
    </View>
  );
}

function TrackerMapMarker({
  tracker,
  onOpenTracker,
  onPressInTracker,
  onPressOutTracker,
  onLongPressTracker,
}: {
  tracker: Tracker;
  onOpenTracker: (trackerId: string) => void;
  onPressInTracker?: (trackerId: string) => void;
  onPressOutTracker?: () => void;
  onLongPressTracker?: (trackerId: string) => void;
}) {
  const handledLongPress = useRef(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tracker.name}
      delayLongPress={3000}
      onPressIn={() => onPressInTracker?.(tracker.id)}
      onPressOut={onPressOutTracker}
      onLongPress={() => {
        handledLongPress.current = true;
        onLongPressTracker?.(tracker.id);
      }}
      onPress={() => {
        if (handledLongPress.current) {
          handledLongPress.current = false;
          return;
        }
        onOpenTracker(tracker.id);
      }}
    >
      <View style={styles.marker}>
              <View style={styles.markerBubble}>
                <TrackerArtwork
                  kind={tracker.kind}
                  style={styles.markerArtwork}
                  decorative
                  carIconSize={27}
                />
              </View>
              <View style={styles.markerTip} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  marker: {
    width: 58,
    height: 70,
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
