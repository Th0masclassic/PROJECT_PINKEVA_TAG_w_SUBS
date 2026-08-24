import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, ScreenTitle, SettingRow, Surface, type IconName } from '../components';
import { LANGUAGE_NATIVE_NAMES, useI18n, type TranslationKey } from '../i18n';
import type { InfoTopic } from '../model';
import { colors, radii } from '../theme';

const avatarAsset = require('../../assets/pinkeva/avatar.png');

type SettingDefinition = {
  icon: IconName;
  topic: InfoTopic;
  titleKey: TranslationKey;
};

const primarySettings: SettingDefinition[] = [
  { icon: 'notifications-outline', topic: 'notifications', titleKey: 'settings.notifications' },
  { icon: 'shield-checkmark-outline', topic: 'privacy', titleKey: 'settings.privacy' },
  { icon: 'lock-closed-outline', topic: 'permissions', titleKey: 'settings.permissions' },
];

const supportSettings: SettingDefinition[] = [
  { icon: 'help-circle-outline', topic: 'support', titleKey: 'settings.help' },
  { icon: 'information-circle-outline', topic: 'about', titleKey: 'settings.about' },
  { icon: 'sync-outline', topic: 'firmware', titleKey: 'settings.firmware' },
];

export function SettingsScreen({
  accountName,
  onOpenInfo,
  onOpenLanguage,
  onSignOut,
}: {
  accountName: string;
  onOpenInfo: (topic: InfoTopic) => void;
  onOpenLanguage: () => void;
  onSignOut: () => void;
}) {
  const { language, t } = useI18n();

  return (
    <AppSafeArea>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} testID="settings-screen">
        <ScreenTitle title={t('settings.title')} subtitle={t('settings.subtitle')} />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openAccount')}
          onPress={() => onOpenInfo('account')}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <Surface style={styles.profileCard}>
            <Image source={avatarAsset} resizeMode="cover" style={styles.avatar} />
            <View style={styles.profileCopy}>
              <Text numberOfLines={2} style={styles.profileName}>{accountName}</Text>
              <Text style={styles.profileSubtitle}>{t('settings.account')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={27} color={colors.muted} />
          </Surface>
        </Pressable>

        <Surface style={styles.groupCard}>
          {primarySettings.map((item) => (
            <SettingRow
              key={item.topic}
              icon={item.icon}
              title={t(item.titleKey)}
              onPress={() => onOpenInfo(item.topic)}
            />
          ))}
          <SettingRow
            icon="globe-outline"
            title={t('settings.language')}
            value={LANGUAGE_NATIVE_NAMES[language]}
            onPress={onOpenLanguage}
            isLast
            testID="change-language"
          />
        </Surface>

        <Surface style={styles.groupCard}>
          {supportSettings.map((item, index) => (
            <SettingRow
              key={item.topic}
              icon={item.icon}
              title={t(item.titleKey)}
              onPress={() => onOpenInfo(item.topic)}
              isLast={index === supportSettings.length - 1}
            />
          ))}
        </Surface>

        <Surface style={styles.groupCard}>
          <SettingRow icon="log-out-outline" title={t('settings.signOut')} danger onPress={onSignOut} isLast testID="sign-out" />
        </Surface>
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: 20, paddingBottom: 30, gap: 20 },
  profileCard: { minHeight: 122, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderRadius: radii.large, gap: 18 },
  avatar: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.navy },
  profileCopy: { flex: 1 },
  profileName: { color: colors.text, fontSize: 24, fontWeight: '800' },
  profileSubtitle: { color: colors.muted, fontSize: 16, marginTop: 6 },
  groupCard: { borderRadius: radii.large, overflow: 'hidden' },
  pressed: { opacity: 0.72 },
});
