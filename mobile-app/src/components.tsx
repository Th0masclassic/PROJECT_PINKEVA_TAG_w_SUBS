import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import {
  Image,
  type ImageStyle,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  formatRelativeTime,
  localizeTrackerPlace,
  useI18n,
  type TranslationKey,
} from './i18n';
import type { MainTab, Tracker, TrackerKind } from './model';
import { colors, radii, shadow } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

const trackerAssets = {
  card: require('../assets/pinkeva/card-transparent.png'),
  keys: require('../assets/pinkeva/keys-transparent.png'),
  backpack: require('../assets/pinkeva/backpack-transparent.png'),
} satisfies Record<Exclude<TrackerKind, 'car'>, number>;

type SurfaceProps = PropsWithChildren<{
  style?: ViewStyle | ViewStyle[];
  accessibilityLabel?: string;
}>;

export function Surface({ children, style, accessibilityLabel }: SurfaceProps) {
  return (
    <View accessibilityLabel={accessibilityLabel} style={[styles.surface, shadow, style]}>
      {children}
    </View>
  );
}

type IconButtonProps = {
  name: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  color?: string;
  size?: number;
  style?: ViewStyle;
  testID?: string;
};

export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  color = colors.text,
  size = 25,
  style,
  testID,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, style, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons name={name} color={color} size={size} />
    </Pressable>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  icon?: IconName;
  testID?: string;
  disabled?: boolean;
  style?: ViewStyle;
};

export function PrimaryButton({
  label,
  onPress,
  icon,
  testID,
  disabled,
  style,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.buttonOuter,
        style,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}
    >
      <LinearGradient
        colors={[colors.blueDark, colors.blue]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.primaryButton}
      >
        {icon ? <Ionicons name={icon} color="#FFFFFF" size={21} /> : null}
        <Text style={styles.primaryButtonLabel}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

export function OutlineButton({ label, onPress, icon, testID, style }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.outlineButton, style, pressed && styles.pressed]}
      testID={testID}
    >
      {icon ? <Ionicons name={icon} color={colors.blue} size={21} /> : null}
      <Text style={styles.outlineButtonLabel}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({
  label,
  onPress,
  danger = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.textButtonLabel, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return <Text style={styles.compactBrand}>P I N K E V A</Text>;
  }

  return (
    <View style={styles.brandRow} accessibilityLabel="Pinkeva">
      <Text style={styles.brandMonogram}>P</Text>
      <Text style={styles.brandName}>Pinkeva</Text>
    </View>
  );
}

export function ScreenTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.screenTitleRow}>
      <View style={styles.screenTitleCopy}>
        <Text style={styles.screenTitle}>{title}</Text>
        {subtitle ? <Text style={styles.screenSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function BackHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.backHeader}>
      <IconButton name="arrow-back" accessibilityLabel={t('a11y.goBack')} onPress={onBack} />
      <Text numberOfLines={1} style={styles.backHeaderTitle}>
        {title}
      </Text>
      <View style={styles.backHeaderSpacer} />
    </View>
  );
}

export function TrackerArtwork({
  kind,
  style,
  resizeMode = 'contain',
  decorative = false,
  carIconSize = 48,
}: {
  kind: TrackerKind;
  style?: ImageStyle | ImageStyle[];
  resizeMode?: 'contain' | 'cover';
  decorative?: boolean;
  carIconSize?: number;
}) {
  const { t } = useI18n();
  const accessibilityLabel = decorative
    ? undefined
    : t('a11y.trackerArtwork', { kind });

  if (kind === 'car') {
    return (
      <View
        accessible={!decorative}
        accessibilityLabel={accessibilityLabel}
        style={[styles.carArtwork, style]}
      >
        <LinearGradient
          colors={['#071C48', '#0B418D']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.carArtworkFill}
        >
          <Ionicons name="car-sport" color="#FFFFFF" size={carIconSize} />
          <View style={styles.carRoadLine} />
        </LinearGradient>
      </View>
    );
  }

  return (
    <Image
      accessible={!decorative}
      accessibilityLabel={accessibilityLabel}
      source={trackerAssets[kind]}
      resizeMode={resizeMode}
      style={[styles.trackerArtwork, style]}
    />
  );
}

export function StatusDot({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <View style={styles.statusRow}>
      <View style={styles.statusDot} />
      <Text style={styles.statusText}>{label ?? t('tracker.nearby')}</Text>
    </View>
  );
}

export function TrackerRow({
  tracker,
  onPress,
  compact = false,
}: {
  tracker: Tracker;
  onPress: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('a11y.openTracker', { name: tracker.name })}
      onPress={onPress}
      style={({ pressed }) => [styles.trackerRow, compact && styles.trackerRowCompact, pressed && styles.pressed]}
      testID={`tracker-${tracker.id}`}
    >
      <View style={[styles.trackerThumb, compact && styles.trackerThumbCompact]}>
        <TrackerArtwork
          kind={tracker.kind}
          style={styles.trackerThumbImage}
          decorative
          carIconSize={compact ? 34 : 48}
        />
      </View>
      <View style={styles.trackerRowCopy}>
        <Text style={[styles.trackerRowTitle, compact && styles.trackerRowTitleCompact]}>
          {tracker.name}
        </Text>
        {tracker.status === 'nearby' && !compact ? (
          <StatusDot />
        ) : (
          <Text style={styles.trackerRowMeta}>
            {t('tracker.lastSeenValue', { time: formatRelativeTime(t, tracker.lastSeen) })}
          </Text>
        )}
        {!compact && tracker.status === 'nearby' ? (
          <Text style={styles.trackerRowMeta}>{localizeTrackerPlace(t, tracker.place)}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={25} color={colors.muted} />
    </Pressable>
  );
}

export function SettingRow({
  icon,
  title,
  subtitle,
  value,
  danger,
  onPress,
  isLast,
  testID,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  danger?: boolean;
  onPress: () => void;
  isLast?: boolean;
  testID?: string;
}) {
  const tint = danger ? colors.danger : colors.blue;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, value, subtitle].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.settingRow, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.settingIcon}>
        <Ionicons name={icon} color={tint} size={27} />
      </View>
      <View style={[styles.settingCopy, !isLast && styles.settingDivider]}>
        <View style={styles.settingTextWrap}>
          <Text style={[styles.settingTitle, danger && { color: colors.danger }]}>{title}</Text>
          {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
        </View>
        {value ? <Text style={styles.settingValue}>{value}</Text> : null}
        <Ionicons name="chevron-forward" size={24} color={colors.muted} />
      </View>
    </Pressable>
  );
}

const tabs: { id: MainTab; labelKey: TranslationKey; icon: IconName; activeIcon: IconName }[] = [
  { id: 'home', labelKey: 'common.home', icon: 'home-outline', activeIcon: 'home' },
  { id: 'trackers', labelKey: 'common.trackers', icon: 'wallet-outline', activeIcon: 'wallet' },
  {
    id: 'map',
    labelKey: 'common.map',
    icon: 'navigate-outline',
    activeIcon: 'navigate',
  },
  { id: 'settings', labelKey: 'common.settings', icon: 'settings-outline', activeIcon: 'settings' },
];

export function BottomNav({ active, onChange }: { active: MainTab; onChange: (tab: MainTab) => void }) {
  const { t } = useI18n();
  return (
    <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
      <View style={styles.bottomNav} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const selected = active === tab.id;
          const label = t(tab.labelKey);
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              onPress={() => onChange(tab.id)}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
              testID={`tab-${tab.id}`}
            >
              <Ionicons
                name={selected ? tab.activeIcon : tab.icon}
                size={29}
                color={selected ? colors.blue : colors.mutedDark}
              />
              <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

export function Toast({ message }: { message: string }) {
  return (
    <View pointerEvents="none" style={[styles.toast, shadow]} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark-circle" color="#FFFFFF" size={20} />
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
}

export function AppSafeArea({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, style]}>
      {children}
    </SafeAreaView>
  );
}

export function Label({ children, style }: PropsWithChildren<{ style?: TextStyle }>) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  surface: { backgroundColor: colors.surface, borderRadius: radii.medium },
  carArtwork: { overflow: 'hidden', borderRadius: 18, backgroundColor: colors.navy },
  carArtworkFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  carRoadLine: {
    position: 'absolute',
    bottom: '18%',
    width: '52%',
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
    borderRadius: 22,
  },
  pressed: { opacity: 0.68, transform: [{ scale: 0.985 }] },
  buttonOuter: { borderRadius: 15, overflow: 'hidden' },
  buttonDisabled: { opacity: 0.5 },
  primaryButton: {
    minHeight: 58,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  primaryButtonLabel: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  outlineButton: {
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: colors.blue,
    borderRadius: 15,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  outlineButtonLabel: { color: colors.blue, fontSize: 18, fontWeight: '700' },
  textButton: { minHeight: 42, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  textButtonLabel: { color: colors.blue, fontSize: 16, fontWeight: '600' },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  brandMonogram: {
    color: colors.navy,
    fontSize: 76,
    fontWeight: '800',
    fontFamily: 'Georgia',
    letterSpacing: -12,
    lineHeight: 82,
  },
  brandName: {
    color: colors.navy,
    fontSize: 51,
    fontWeight: '500',
    fontFamily: 'Georgia',
    letterSpacing: -2,
  },
  compactBrand: { color: colors.navy, fontSize: 20, fontWeight: '500', letterSpacing: 8 },
  screenTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 22,
  },
  screenTitleCopy: { flex: 1, paddingRight: 12 },
  screenTitle: { color: colors.text, fontSize: 36, fontWeight: '800', letterSpacing: -1 },
  screenSubtitle: { color: colors.muted, fontSize: 17, marginTop: 5 },
  backHeader: {
    minHeight: 70,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backHeaderTitle: { color: colors.text, fontSize: 23, fontWeight: '800', flex: 1, textAlign: 'center' },
  backHeaderSpacer: { width: 44 },
  trackerArtwork: { width: 150, height: 100 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { height: 12, width: 12, backgroundColor: colors.success, borderRadius: 6 },
  statusText: { color: colors.blue, fontSize: 17, fontWeight: '500' },
  trackerRow: {
    minHeight: 124,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 14,
  },
  trackerRowCompact: { minHeight: 72, paddingVertical: 8, paddingHorizontal: 12 },
  trackerThumb: {
    width: 116,
    height: 88,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#FBFCFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackerThumbCompact: { width: 66, height: 50, borderRadius: 9 },
  trackerThumbImage: { width: '100%', height: '100%' },
  trackerRowCopy: { flex: 1, gap: 4 },
  trackerRowTitle: { color: colors.text, fontSize: 22, fontWeight: '700' },
  trackerRowTitleCompact: { fontSize: 17 },
  trackerRowMeta: { color: colors.muted, fontSize: 15 },
  settingRow: { minHeight: 76, flexDirection: 'row', alignItems: 'stretch', paddingLeft: 18 },
  settingIcon: { width: 44, alignItems: 'flex-start', justifyContent: 'center' },
  settingCopy: {
    flex: 1,
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 17,
    gap: 8,
  },
  settingDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingTextWrap: { flex: 1, gap: 3 },
  settingTitle: { color: colors.text, fontSize: 18, fontWeight: '600' },
  settingSubtitle: { color: colors.muted, fontSize: 14 },
  settingValue: { color: colors.muted, fontSize: 16, maxWidth: 110 },
  bottomSafeArea: { backgroundColor: 'rgba(255,255,255,0.98)' },
  bottomNav: {
    minHeight: 82,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.98)',
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14 },
  tabLabel: { color: colors.mutedDark, fontSize: 13, fontWeight: '500' },
  tabLabelSelected: { color: colors.blue },
  toast: {
    position: 'absolute',
    left: 22,
    right: 22,
    bottom: 112,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: colors.navy,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    zIndex: 100,
  },
  toastText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  label: { color: colors.mutedDark, fontSize: 14, fontWeight: '600' },
});
