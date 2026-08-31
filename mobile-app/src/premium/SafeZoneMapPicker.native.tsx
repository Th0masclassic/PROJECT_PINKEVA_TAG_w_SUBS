import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, type MapPressEvent } from 'react-native-maps';

export type SafeZoneCoordinate = { latitude: number; longitude: number };

const FALLBACK = { latitude: 38.7223, longitude: -9.1393 };

export function SafeZoneMapPicker({
  coordinate,
  onChange,
}: {
  coordinate?: SafeZoneCoordinate;
  onChange: (coordinate: SafeZoneCoordinate) => void;
}) {
  const map = useRef<MapView>(null);
  const selected = coordinate ?? FALLBACK;

  useEffect(() => {
    if (!coordinate) return;
    map.current?.animateToRegion({
      ...coordinate,
      latitudeDelta: 0.018,
      longitudeDelta: 0.018,
    }, 300);
  }, [coordinate?.latitude, coordinate?.longitude]);

  const select = (event: MapPressEvent) => {
    onChange(event.nativeEvent.coordinate);
  };

  return (
    <View style={styles.frame} testID="safe-zone-map-picker">
      <MapView
        ref={map}
        initialRegion={{ ...selected, latitudeDelta: 0.018, longitudeDelta: 0.018 }}
        onPress={select}
        showsCompass
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        style={StyleSheet.absoluteFill}
      >
        {coordinate ? (
          <Marker
            coordinate={coordinate}
            draggable
            onDragEnd={(event) => onChange(event.nativeEvent.coordinate)}
            pinColor="#0B57D0"
          />
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 210,
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: '#EAF2FB',
  },
});
