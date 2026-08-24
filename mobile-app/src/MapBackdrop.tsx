import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from './theme';

const roads = [
  { top: '9%', left: '-20%', width: '150%', rotate: '13deg', major: true },
  { top: '21%', left: '-10%', width: '135%', rotate: '-9deg', major: false },
  { top: '34%', left: '-15%', width: '145%', rotate: '4deg', major: true },
  { top: '48%', left: '-10%', width: '135%', rotate: '-13deg', major: false },
  { top: '62%', left: '-12%', width: '145%', rotate: '10deg', major: true },
  { top: '77%', left: '-15%', width: '150%', rotate: '-5deg', major: false },
  { top: '18%', left: '-15%', width: '140%', rotate: '72deg', major: false },
  { top: '35%', left: '-18%', width: '150%', rotate: '84deg', major: true },
  { top: '48%', left: '-20%', width: '155%', rotate: '96deg', major: false },
  { top: '62%', left: '-15%', width: '145%', rotate: '106deg', major: true },
] as const;

export function MapBackdrop({
  style,
  compact = false,
}: {
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  return (
    <View
      style={[styles.canvas, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.waterTop} />
      <View style={styles.waterRight} />
      <View style={styles.coastline} />
      <View style={[styles.park, styles.parkOne]} />
      <View style={[styles.park, styles.parkTwo]} />
      <View style={[styles.park, styles.parkThree]} />
      {roads.map((road) => (
        <View
          key={`${road.top}-${road.rotate}`}
          style={[
            styles.road,
            road.major && styles.majorRoad,
            {
              top: road.top,
              left: road.left,
              width: road.width,
              transform: [{ rotate: road.rotate }],
            },
          ]}
        >
          {road.major ? <View style={styles.roadCenter} /> : null}
        </View>
      ))}
      {!compact ? (
        <>
          <Text style={[styles.neighborhood, { left: '8%', top: '37%' }]}>PACIFIC HEIGHTS</Text>
          <Text style={[styles.neighborhood, { left: '43%', top: '52%' }]}>NOB HILL</Text>
          <Text style={[styles.neighborhood, { right: '9%', top: '70%' }]}>MISSION BAY</Text>
          <Text style={[styles.roadLabel, { left: '18%', top: '58%', transform: [{ rotate: '-13deg' }] }]}>Geary Blvd</Text>
          <Text style={[styles.roadLabel, { right: '22%', top: '31%', transform: [{ rotate: '10deg' }] }]}>Market St</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { overflow: 'hidden', backgroundColor: '#F5F8F5' },
  waterTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '16%', backgroundColor: colors.mapWater },
  waterRight: { position: 'absolute', top: '10%', right: 0, bottom: 0, width: '12%', backgroundColor: colors.mapWater },
  coastline: {
    position: 'absolute', right: '7%', top: '7%', width: '18%', height: '105%',
    backgroundColor: '#F5F8F5', transform: [{ rotate: '8deg' }],
  },
  park: { position: 'absolute', backgroundColor: '#CEE8D0', opacity: 0.86, borderRadius: 24 },
  parkOne: { left: '-4%', top: '23%', width: '34%', height: '25%', transform: [{ rotate: '-8deg' }] },
  parkTwo: { left: '33%', top: '45%', width: '18%', height: '14%', transform: [{ rotate: '12deg' }] },
  parkThree: { right: '13%', bottom: '10%', width: '22%', height: '17%', transform: [{ rotate: '-6deg' }] },
  road: { position: 'absolute', height: 3, backgroundColor: '#FFFFFF', borderColor: '#D9E0E7', borderWidth: StyleSheet.hairlineWidth },
  majorRoad: { height: 7, backgroundColor: '#FCFDFE', borderColor: '#BFC9D6' },
  roadCenter: { position: 'absolute', left: 0, right: 0, top: 2.5, height: 1, backgroundColor: '#D7E0EA' },
  neighborhood: { position: 'absolute', color: '#596276', fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  roadLabel: { position: 'absolute', color: '#6E7688', fontSize: 9, fontWeight: '600' },
});
