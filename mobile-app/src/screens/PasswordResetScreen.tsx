import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Brand, PrimaryButton } from '../components';
import { useI18n } from '../i18n';
import { colors, radii } from '../theme';

export function PasswordResetScreen({
  busy,
  onSubmit,
  onCancel,
  onNotice,
}: {
  busy: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);

  const submit = () => {
    if (password.length < 8) {
      onNotice(t('auth.passwordTooShort', { count: 8 }));
      return;
    }
    if (password !== confirmation) {
      onNotice(t('auth.passwordMismatch'));
      return;
    }
    onSubmit(password);
  };

  return (
    <View style={styles.screen} testID="password-reset-screen">
      <View style={styles.content}>
        <Brand />
        <Text style={styles.title}>{t('auth.updatePassword')}</Text>
        <Text style={styles.body}>{t('auth.passwordTooShort', { count: 8 })}</Text>

        <View style={styles.inputShell}>
          <Ionicons name="lock-closed-outline" color={colors.mutedDark} size={23} />
          <TextInput
            autoCapitalize="none"
            autoComplete="new-password"
            editable={!busy}
            onChangeText={setPassword}
            maxLength={128}
            placeholder={t('auth.newPassword')}
            placeholderTextColor="#A0A8BC"
            secureTextEntry={!visible}
            style={styles.input}
            textContentType="newPassword"
            value={password}
          />
          <Pressable
            accessibilityLabel={visible ? t('a11y.hidePassword') : t('a11y.showPassword')}
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => setVisible((current) => !current)}
          >
            <Ionicons
              name={visible ? 'eye-off-outline' : 'eye-outline'}
              color={colors.mutedDark}
              size={23}
            />
          </Pressable>
        </View>

        <View style={styles.inputShell}>
          <Ionicons name="shield-checkmark-outline" color={colors.mutedDark} size={23} />
          <TextInput
            autoCapitalize="none"
            autoComplete="new-password"
            editable={!busy}
            onChangeText={setConfirmation}
            maxLength={128}
            onSubmitEditing={submit}
            placeholder={t('auth.confirmPassword')}
            placeholderTextColor="#A0A8BC"
            returnKeyType="done"
            secureTextEntry={!visible}
            style={styles.input}
            textContentType="newPassword"
            value={confirmation}
          />
        </View>

        <PrimaryButton
          disabled={busy}
          label={busy ? t('auth.working') : t('auth.updatePassword')}
          onPress={submit}
          testID="password-reset-submit"
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onCancel}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
        >
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    padding: 24,
  },
  content: { width: '100%', maxWidth: 520, gap: 14, alignItems: 'stretch' },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', marginTop: 18, textAlign: 'center' },
  body: { color: colors.mutedDark, fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 8 },
  inputShell: {
    minHeight: 58,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  input: { flex: 1, minHeight: 56, color: colors.text, fontSize: 17 },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: colors.blue, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.68 },
});
