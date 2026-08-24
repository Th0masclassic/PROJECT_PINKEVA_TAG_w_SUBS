import { useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type LatLng, type MapType } from 'react-native-maps';

import { TrackerArtwork } from '../components';
import type { Tracker } from '../model';

const FALLBACK_REGION = {
  latitude: 38.7223,
  longitude: -9.1393,
  latitudeDelta: 0.18,
  longitudeDelta: 0.18,
};

export function GoogleTrackerMap({
  trackers,
  mapType,
  recenterToken,
  onOpenTracker,
}: {
  trackers: Tracker[];
  mapType: 'standard' | 'satellite';
  recenterToken: number;
  onOpenTracker: (trackerId: string) => void;
}) {
  const ref = useRef<MapView>(null);
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

  const fitMarkers = () => {
    if (!ref.current) return;
    if (coordinates.length === 0) {
      ref.current.animateToRegion(FALLBACK_REGION, 450);
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
  };

  useEffect(() => {
    if (recenterToken > 0) fitMarkers();
  }, [recenterToken]);

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
        onMapReady={fitMarkers}
        rotateEnabled
        pitchEnabled
        showsCompass
        showsScale
        toolbarEnabled={false}
        style={StyleSheet.absoluteFill}
        testID="google-tracker-map"
      >
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
            <View style={styles.marker} accessible accessibilityLabel={tracker.name}>
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
          </Marker>
        ))}
      </MapView>
    </View>
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
