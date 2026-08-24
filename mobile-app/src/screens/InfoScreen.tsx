import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, BackHeader, PrimaryButton, Surface, type IconName } from '../components';
import { useI18n, type TranslationKey } from '../i18n';
import type { InfoTopic } from '../model';
import { colors } from '../theme';

const topics: Record<InfoTopic, { title: TranslationKey; message: TranslationKey; icon: IconName }> = {
  account: { title: 'settings.account', message: 'settings.accountMessage', icon: 'person-circle-outline' },
  notifications: { title: 'settings.notifications', message: 'settings.notificationsMessage', icon: 'notifications-outline' },
  privacy: { title: 'settings.privacy', message: 'settings.privacyMessage', icon: 'shield-checkmark-outline' },
  permissions: { title: 'settings.permissions', message: 'settings.permissionsMessage', icon: 'lock-closed-outline' },
  support: { title: 'settings.help', message: 'settings.helpMessage', icon: 'help-circle-outline' },
  about: { title: 'settings.about', message: 'settings.aboutMessage', icon: 'information-circle-outline' },
  firmware: { title: 'settings.firmware', message: 'settings.firmwareMessage', icon: 'sync-outline' },
};

export function InfoScreen({ topic, onBack }: { topic: InfoTopic; onBack: () => void }) {
  const { t } = useI18n();
  const content = topics[topic];
  return (
    <AppSafeArea>
      <BackHeader title={t(content.title)} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Surface style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name={content.icon} size={38} color={colors.blue} />
          </View>
          <Text style={styles.title}>{t(content.title)}</Text>
          <Text style={styles.message}>{t(content.message)}</Text>
          <View style={styles.demoPill}>
            <View style={styles.demoDot} />
            <Text style={styles.demoText}>{t('info.staticDemo')}</Text>
          </View>
        </Surface>
        <PrimaryButton label={t('common.done')} onPress={onBack} />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 22, justifyContent: 'center', gap: 22 },
  card: { padding: 28, alignItems: 'center' },
  iconCircle: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', textAlign: 'center' },
  message: { color: colors.mutedDark, fontSize: 17, lineHeight: 26, textAlign: 'center', marginTop: 14 },
  demoPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, borderRadius: 999, backgroundColor: '#F3F6FC', paddingHorizontal: 14, paddingVertical: 9 },
  demoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue },
  demoText: { color: colors.mutedDark, fontSize: 13, fontWeight: '600' },
});
