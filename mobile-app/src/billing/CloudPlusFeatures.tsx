import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radii } from '../theme';
import { useCloudPlusCopy } from './cloudPlusCopy';

export function CloudPlusFeatures({ compact = false }: { compact?: boolean }) {
  const copy = useCloudPlusCopy();
  const features = [
    { id: 'recovery', icon: 'shield-checkmark-outline' as const, title: copy.recoveryTitle, body: copy.recoveryBody },
    { id: 'separation', icon: 'notifications-outline' as const, title: copy.separationTitle, body: copy.separationBody },
    { id: 'history', icon: 'time-outline' as const, title: copy.historyTitle, body: copy.historyBody },
    { id: 'discount', icon: 'pricetag-outline' as const, title: copy.discountTitle, body: copy.discountBody },
  ];

  return (
    <View style={styles.container} testID="cloud-plus-features">
      <Text style={styles.title}>{copy.includedTitle}</Text>
      <View style={styles.stack}>
        {features.map((feature) => (
          <View
            key={feature.id}
            style={[styles.feature, compact && styles.featureCompact]}
            testID={`cloud-plus-feature-${feature.id}`}
          >
            <View style={[styles.icon, compact && styles.iconCompact]}>
              <Ionicons name={feature.icon} size={compact ? 20 : 23} color={colors.blue} />
            </View>
            <View style={styles.copy}>
              <Text style={styles.featureTitle}>{feature.title}</Text>
              <Text style={styles.featureBody}>{feature.body}</Text>
            </View>
            <Ionicons name="checkmark-circle" size={21} color={colors.blue} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 11 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  stack: { gap: 9 },
  feature: {
    minHeight: 78,
    borderRadius: radii.medium,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  featureCompact: { minHeight: 70, padding: 11 },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: colors.bluePale,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCompact: { width: 40, height: 40, borderRadius: 13 },
  copy: { flex: 1, gap: 3 },
  featureTitle: { color: colors.text, fontSize: 15, lineHeight: 19, fontWeight: '800' },
  featureBody: { color: colors.mutedDark, fontSize: 12, lineHeight: 17 },
});
