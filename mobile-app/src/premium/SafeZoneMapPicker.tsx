import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { MapBackdrop } from '../MapBackdrop';
import { colors } from '../theme';

export type SafeZoneCoordinate = { latitude: number; longitude: number };

export function SafeZoneMapPicker({
  coordinate,
  onChange: _onChange,
}: {
  coordinate?: SafeZoneCoordinate;
  onChange: (coordinate: SafeZoneCoordinate) => void;
}) {
  return (
    <View style={styles.frame} testID="safe-zone-map-web-preview">
      <MapBackdrop style={StyleSheet.absoluteFill} />
      {coordinate ? (
        <View style={styles.pin}>
          <Ionicons name="location" size={34} color={colors.blue} />
        </View>
      ) : null}
      <View style={styles.notice}>
        <Text style={styles.noticeText}>Tap-to-select is available in the iPhone and Android app. Coordinates and current location still work here.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 210,
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: '#EAF2FB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pin: { marginBottom: 42 },
  notice: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    borderRadius: 12,
    padding: 9,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  noticeText: { color: colors.mutedDark, fontSize: 11, lineHeight: 15, textAlign: 'center' },
});
