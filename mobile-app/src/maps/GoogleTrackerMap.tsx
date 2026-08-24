import { StyleSheet, View } from 'react-native';

import { MapBackdrop } from '../MapBackdrop';
import type { Tracker } from '../model';

export function GoogleTrackerMap({
  trackers: _trackers,
  mapType: _mapType,
  recenterToken: _recenterToken,
  onOpenTracker: _onOpenTracker,
}: {
  trackers: Tracker[];
  mapType: 'standard' | 'satellite';
  recenterToken: number;
  onOpenTracker: (trackerId: string) => void;
}) {
  return (
    <View style={StyleSheet.absoluteFill} testID="google-map-web-fallback">
      <MapBackdrop style={StyleSheet.absoluteFill} />
    </View>
  );
}
