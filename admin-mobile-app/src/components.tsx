import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadow } from './theme';
import type { AdminSection } from './types';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function Brand({ admin = false }: { admin?: boolean }) {
  return (
    <View style={styles.brandWrap} accessibilityLabel={admin ? 'Pinkeva Admin' : 'Pinkeva'}>
      <View style={styles.brandRow}>
        <Text style={styles.brandMonogram}>P</Text>
        <Text style={styles.brandName}>Pinkeva</Text>
      </View>
      {admin ? <Text style={styles.adminWord}>A D M I N</Text> : null}
    </View>
  );
}

export function Surface({ children, style }: PropsWithChildren<{ style?: ViewStyle | ViewStyle[] }>) {
  return <View style={[styles.surface, shadow, style]}>{children}</View>;
}

export function PrimaryButton({
  label,
  icon,
  onPress,
  disabled,
  compact,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryOuter,
        compact && styles.compactButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <LinearGradient
        colors={[colors.blueDark, colors.blue]}
        start={{ x: 0, y: .5 }}
        end={{ x: 1, y: .5 }}
        style={[styles.primaryFill, compact && styles.compactButton]}
      >
        {icon ? <Ionicons name={icon} color="#FFFFFF" size={compact ? 18 : 21} /> : null}
        <Text style={[styles.primaryLabel, compact && styles.compactLabel]}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  icon,
  onPress,
  danger,
  disabled,
  compact,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        danger && styles.dangerButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {icon ? <Ionicons name={icon} color={danger ? colors.danger : colors.blue} size={compact ? 18 : 21} /> : null}
      <Text style={[styles.secondaryLabel, danger && styles.dangerLabel, compact && styles.compactLabel]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={23} color={colors.text} />
    </Pressable>
  );
}

export function Field({ label, icon, style, ...props }: TextInputProps & { label: string; icon?: IconName }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldShell}>
        {icon ? <Ionicons name={icon} size={21} color={colors.mutedDark} /> : null}
        <TextInput
          {...props}
          accessibilityLabel={label}
          placeholderTextColor="#9AA4B8"
          style={[styles.fieldInput, props.multiline && styles.fieldInputMultiline, style]}
        />
      </View>
    </View>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {onBack ? <IconButton icon="arrow-back" label="Go back" onPress={onBack} /> : null}
      <View style={styles.headerCopy}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      {right ?? (onBack ? <View style={styles.headerSpacer} /> : null)}
    </View>
  );
}

export function SectionIntro({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.sectionIntro}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {body ? <Text style={styles.sectionBody}>{body}</Text> : null}
    </View>
  );
}

export function Badge({ label, tone = 'blue' }: { label: string; tone?: 'blue' | 'green' | 'navy' | 'danger' }) {
  return (
    <View style={[styles.badge, tone === 'green' && styles.badgeGreen, tone === 'navy' && styles.badgeNavy, tone === 'danger' && styles.badgeDanger]}>
      <Text style={[styles.badgeText, tone === 'green' && styles.badgeTextGreen, tone === 'navy' && styles.badgeTextNavy, tone === 'danger' && styles.badgeTextDanger]}>{label}</Text>
    </View>
  );
}

export function LoadingState({ label = 'Loading secure data…' }: { label?: string }) {
  return (
    <View style={styles.stateWrap}>
      <ActivityIndicator size="large" color={colors.blue} />
      <Text style={styles.stateText}>{label}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View style={styles.stateWrap}>
      <View style={styles.stateIcon}><Ionicons name={icon} size={28} color={colors.blue} /></View>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateText}>{body}</Text>
    </View>
  );
}

const tabs: { id: AdminSection; label: string; icon: IconName; activeIcon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'grid-outline', activeIcon: 'grid' },
  { id: 'users', label: 'Users', icon: 'people-outline', activeIcon: 'people' },
  { id: 'plans', label: 'Plans', icon: 'card-outline', activeIcon: 'card' },
  { id: 'more', label: 'More', icon: 'menu-outline', activeIcon: 'menu' },
];

export function BottomNav({ active, onChange }: { active: AdminSection; onChange: (tab: AdminSection) => void }) {
  return (
    <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
      <View style={styles.bottomNav} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onChange(tab.id)}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              <Ionicons name={selected ? tab.activeIcon : tab.icon} size={24} color={selected ? colors.blue : colors.mutedDark} />
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

export function MenuRow({
  icon,
  title,
  subtitle,
  onPress,
  danger,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
    >
      <View style={[styles.menuIcon, danger && styles.menuIconDanger]}>
        <Ionicons name={icon} size={22} color={danger ? colors.danger : colors.blue} />
      </View>
      <View style={styles.menuCopy}>
        <Text style={[styles.menuTitle, danger && { color: colors.danger }]}>{title}</Text>
        {subtitle ? <Text style={styles.menuSubtitle}>{subtitle}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={21} color={colors.muted} />
    </Pressable>
  );
}

export function Toast({ message, error }: { message: string | null; error?: boolean }) {
  if (!message) return null;
  return (
    <View style={[styles.toast, error && styles.toastError]} accessibilityRole="alert">
      <Ionicons name={error ? 'alert-circle' : 'checkmark-circle'} color="#FFFFFF" size={21} />
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  brandWrap: { alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  brandMonogram: { color: colors.navy, fontSize: 68, fontWeight: '800', fontFamily: 'Georgia', letterSpacing: -11, lineHeight: 74 },
  brandName: { color: colors.navy, fontSize: 45, fontWeight: '500', fontFamily: 'Georgia', letterSpacing: -2 },
  adminWord: { marginTop: -7, marginLeft: 28, color: colors.blue, fontSize: 12, fontWeight: '800', letterSpacing: 5 },
  surface: { minWidth: 0, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: radii.medium, backgroundColor: colors.surface },
  primaryOuter: { minHeight: 56, overflow: 'hidden', borderRadius: 15 },
  primaryFill: { minHeight: 56, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  primaryLabel: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  secondaryButton: { minHeight: 54, borderRadius: 15, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.bluePale },
  secondaryLabel: { color: colors.blue, fontSize: 16, fontWeight: '700' },
  dangerButton: { backgroundColor: colors.dangerPale },
  dangerLabel: { color: colors.danger },
  compactButton: { minHeight: 40, borderRadius: 12 },
  compactLabel: { fontSize: 14 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: colors.surface },
  disabled: { opacity: .48 },
  pressed: { opacity: .68, transform: [{ scale: .985 }] },
  fieldWrap: { gap: 7 },
  fieldLabel: { color: colors.mutedDark, fontSize: 13, fontWeight: '700' },
  fieldShell: { minHeight: 56, borderWidth: 1, borderColor: colors.border, borderRadius: radii.small, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.surface },
  fieldInput: { flex: 1, minHeight: 54, color: colors.text, fontSize: 16 },
  fieldInputMultiline: { minHeight: 92, paddingVertical: 14, textAlignVertical: 'top' },
  header: { minHeight: 82, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -.7 },
  headerSubtitle: { marginTop: 2, color: colors.muted, fontSize: 14 },
  headerSpacer: { width: 44 },
  sectionIntro: { gap: 6, marginBottom: 18 },
  sectionTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  sectionBody: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.bluePale },
  badgeGreen: { backgroundColor: colors.successPale },
  badgeNavy: { backgroundColor: colors.navy },
  badgeDanger: { backgroundColor: colors.dangerPale },
  badgeText: { color: colors.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .5 },
  badgeTextGreen: { color: colors.success },
  badgeTextNavy: { color: '#FFFFFF' },
  badgeTextDanger: { color: colors.danger },
  stateWrap: { minHeight: 260, padding: 28, alignItems: 'center', justifyContent: 'center', gap: 12 },
  stateIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  stateTitle: { color: colors.text, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  stateText: { maxWidth: 300, color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  bottomSafeArea: { backgroundColor: 'rgba(255,255,255,.98)' },
  bottomNav: { minHeight: 76, paddingHorizontal: 18, paddingTop: 8, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: 'rgba(255,255,255,.98)' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14 },
  tabLabel: { color: colors.mutedDark, fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: colors.blue },
  menuRow: { minHeight: 78, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  menuIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.bluePale },
  menuIconDanger: { backgroundColor: colors.dangerPale },
  menuCopy: { flex: 1, minWidth: 0, gap: 3 },
  menuTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  menuSubtitle: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  toast: { position: 'absolute', zIndex: 50, left: 18, right: 18, bottom: 98, minHeight: 52, borderRadius: 16, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: colors.navy },
  toastError: { backgroundColor: '#9C1D2A' },
  toastText: { flexShrink: 1, color: '#FFFFFF', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
