import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { normalizeUserDisplayName } from '../auth/userNames';
import { AppSafeArea, BackHeader, PrimaryButton, Surface } from '../components';
import { useI18n } from '../i18n';
import { colors, radii } from '../theme';

export function AccountScreen({
  accountName,
  email,
  busy,
  onBack,
  onSaveName,
  onNotice,
}: {
  accountName: string;
  email: string | null;
  busy: boolean;
  onBack: () => void;
  onSaveName: (name: string) => Promise<boolean>;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(accountName);
  const [saving, setSaving] = useState(false);
  const normalizedName = useMemo(() => normalizeUserDisplayName(name), [name]);

  useEffect(() => {
    setName(accountName);
  }, [accountName]);

  const save = async () => {
    if (!normalizedName) {
      onNotice(t('auth.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const saved = await onSaveName(normalizedName);
      if (saved) setName(normalizedName);
    } finally {
      setSaving(false);
    }
  };

  const unchanged = normalizedName === accountName;

  return (
    <AppSafeArea>
      <BackHeader title={t('settings.account')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Surface style={styles.profileCard}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={37} color="#FFFFFF" />
          </View>
          <Text style={styles.profileName}>{accountName}</Text>
          <Text style={styles.profileMessage}>{t('settings.accountMessage')}</Text>
        </Surface>

        <Surface style={styles.formCard}>
          <Text style={styles.fieldLabel}>{t('auth.fullName')}</Text>
          <TextInput
            accessibilityLabel={t('auth.fullName')}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={80}
            onChangeText={setName}
            placeholder={t('auth.fullName')}
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            style={styles.input}
            value={name}
            testID="account-name"
          />
          <View style={styles.divider} />
          <Text style={styles.fieldLabel}>{t('auth.email')}</Text>
          <View style={styles.emailRow}>
            <Ionicons name="mail-outline" size={20} color={colors.mutedDark} />
            <Text numberOfLines={1} style={styles.emailValue}>{email ?? '—'}</Text>
          </View>
        </Surface>

        <PrimaryButton
          disabled={busy || saving || !normalizedName || unchanged}
          label={saving || busy ? t('auth.working') : t('common.save')}
          onPress={() => void save()}
          testID="account-save"
        />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 4, paddingBottom: 36, gap: 18 },
  profileCard: { alignItems: 'center', padding: 24, gap: 10, borderRadius: radii.large },
  avatar: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blue,
  },
  profileName: { color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  profileMessage: { color: colors.mutedDark, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  formCard: { padding: 18, borderRadius: radii.large, gap: 9 },
  fieldLabel: { color: colors.mutedDark, fontSize: 14, fontWeight: '700' },
  input: {
    minHeight: 50,
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    paddingHorizontal: 0,
    paddingVertical: 6,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 8 },
  emailRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  emailValue: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
});
