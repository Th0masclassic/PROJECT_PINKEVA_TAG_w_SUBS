import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInput as TextInputType,
  View,
} from 'react-native';

import { Brand, PrimaryButton } from '../components';
import { AppleSignInButton } from '../auth/AppleSignInButton';
import { getDemoPreviewCopy } from '../auth/demoPreview';
import type { AuthMode, EmailAuthInput } from '../auth/types';
import { LANGUAGE_NATIVE_NAMES, useI18n } from '../i18n';
import { colors, radii } from '../theme';

export function AuthScreen({
  mode,
  onModeChange,
  onEmailAuthenticate,
  onGoogleAuthenticate,
  onAppleAuthenticate,
  onForgotPassword,
  onNotice,
  onChangeLanguage,
  configured,
  busy,
  showDemoPreview,
  onDemoPreview,
}: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onEmailAuthenticate: (input: EmailAuthInput) => void;
  onGoogleAuthenticate: () => void;
  onAppleAuthenticate: () => void;
  onForgotPassword: (email: string) => void;
  onNotice: (message: string) => void;
  onChangeLanguage: () => void;
  configured: boolean;
  busy: boolean;
  showDemoPreview: boolean;
  onDemoPreview: () => void;
}) {
  const { language, t } = useI18n();
  const demoPreviewCopy = getDemoPreviewCopy(language);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const emailRef = useRef<TextInputType>(null);
  const passwordRef = useRef<TextInputType>(null);
  const confirmRef = useRef<TextInputType>(null);

  const submit = () => {
    if (busy || !configured) return;
    if (!email.trim() || !password || (mode === 'register' && !confirmPassword)) {
      onNotice(t('auth.completeFields'));
      return;
    }
    if (mode === 'register' && !name.trim()) {
      onNotice(t('auth.nameRequired'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      onNotice(t('auth.invalidEmail'));
      return;
    }
    if (password.length < 8) {
      onNotice(t('auth.passwordTooShort', { count: 8 }));
      return;
    }
    if (mode === 'register' && password !== confirmPassword) {
      onNotice(t('auth.passwordMismatch'));
      return;
    }
    onEmailAuthenticate({ mode, name, email, password });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.keyboardView}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          <View style={styles.brandWrap}>
            <Brand />
            <View style={styles.taglineRow}>
              <Ionicons name="shield-checkmark-outline" size={21} color={colors.blue} />
              <Text style={styles.tagline}>{t('auth.tagline')}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('language.changeTitle')}
              onPress={onChangeLanguage}
              style={({ pressed }) => [styles.languageButton, pressed && styles.pressed]}
              testID="auth-language"
            >
              <Ionicons name="language-outline" size={17} color={colors.blue} />
              <Text style={styles.languageButtonText}>{LANGUAGE_NATIVE_NAMES[language]}</Text>
              <Ionicons name="chevron-down" size={15} color={colors.blue} />
            </Pressable>
          </View>

          <View style={styles.segment} accessibilityRole="tablist">
            {(['login', 'register'] as AuthMode[]).map((item) => {
              const selected = item === mode;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  disabled={busy}
                  onPress={() => onModeChange(item)}
                  style={({ pressed }) => [
                    styles.segmentButton,
                    selected && styles.segmentButtonSelected,
                    pressed && styles.pressed,
                  ]}
                  testID={`auth-tab-${item}`}
                >
                  <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>
                    {item === 'login' ? t('auth.login') : t('auth.register')}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.form}>
            {mode === 'register' ? (
              <AuthInput
                icon="person-outline"
                value={name}
                onChangeText={setName}
                editable={!busy}
                placeholder={t('auth.fullName')}
                maxLength={80}
                textContentType="name"
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
                testID="register-name"
              />
            ) : null}
            <AuthInput
              inputRef={emailRef}
              icon="mail-outline"
              value={email}
              onChangeText={setEmail}
              editable={!busy}
              placeholder={t('auth.email')}
              maxLength={254}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              testID="auth-email"
            />
            <AuthInput
              inputRef={passwordRef}
              icon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              placeholder={t('auth.password')}
              maxLength={128}
              secureTextEntry={!passwordVisible}
              autoCapitalize="none"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              textContentType={mode === 'login' ? 'password' : 'newPassword'}
              returnKeyType={mode === 'login' ? 'done' : 'next'}
              onSubmitEditing={mode === 'login' ? submit : () => confirmRef.current?.focus()}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    passwordVisible ? t('a11y.hidePassword') : t('a11y.showPassword')
                  }
                  onPress={() => setPasswordVisible((visible) => !visible)}
                  hitSlop={10}
                >
                  <Ionicons
                    name={passwordVisible ? 'eye-off-outline' : 'eye-outline'}
                    size={24}
                    color={colors.mutedDark}
                  />
                </Pressable>
              }
              testID="auth-password"
            />
            {mode === 'register' ? (
              <AuthInput
                inputRef={confirmRef}
                icon="shield-checkmark-outline"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                editable={!busy}
                placeholder={t('auth.confirmPassword')}
                maxLength={128}
                secureTextEntry={!passwordVisible}
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="done"
                onSubmitEditing={submit}
                testID="register-confirm-password"
              />
            ) : null}

            {mode === 'login' ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  if (!email.trim()) onNotice(t('auth.enterEmailForReset'));
                  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                    onNotice(t('auth.invalidEmail'));
                  } else onForgotPassword(email);
                }}
                style={styles.forgotButton}
              >
                <Text style={styles.forgotText}>{t('auth.forgotPassword')}</Text>
              </Pressable>
            ) : null}

            <PrimaryButton
              label={busy ? t('auth.working') : mode === 'login' ? t('auth.login') : t('auth.createAccount')}
              disabled={busy || !configured}
              onPress={submit}
              testID="auth-submit"
              style={styles.primaryAction}
            />

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onModeChange(mode === 'login' ? 'register' : 'login')}
              style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
              testID="auth-secondary"
            >
              <Text style={styles.secondaryActionLabel}>
                {mode === 'login' ? t('auth.createAccount') : t('auth.alreadyHaveAccount')}
              </Text>
            </Pressable>
          </View>

          {!configured ? (
            <Text accessibilityRole="alert" style={styles.configurationMessage}>
              {t('auth.configurationUnavailable')}
            </Text>
          ) : null}

          {showDemoPreview ? (
            <Pressable
              accessibilityRole="button"
              onPress={onDemoPreview}
              style={({ pressed }) => [styles.demoPreview, pressed && styles.pressed]}
              testID="auth-demo-preview"
            >
              <View style={styles.demoPreviewIcon}>
                <Ionicons name="flask-outline" size={22} color="#704600" />
              </View>
              <View style={styles.demoPreviewCopy}>
                <Text style={styles.demoPreviewTitle}>{demoPreviewCopy.button}</Text>
                <Text style={styles.demoPreviewNote}>{demoPreviewCopy.note}</Text>
              </View>
              <Ionicons name="arrow-forward" size={21} color="#704600" />
            </Pressable>
          ) : null}

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.orText}>{t('auth.or')}</Text>
            <View style={styles.divider} />
          </View>

          <View style={styles.socialStack}>
            <AppleSignInButton
              accessibilityLabel={t('auth.continueApple')}
              onPress={onAppleAuthenticate}
              disabled={busy || !configured}
            />
            <SocialButton
              label={t('auth.continueGoogle')}
              onPress={onGoogleAuthenticate}
              disabled={busy || !configured}
            />
          </View>

          <Text style={styles.legalText}>
            {t('auth.legalPrefix')}{' '}
            <Text style={styles.legalLink} onPress={() => onNotice(t('auth.termsNotice'))}>
              {t('auth.terms')}
            </Text>{' '}
            {t('auth.and')}{' '}
            <Text style={styles.legalLink} onPress={() => onNotice(t('auth.privacyNotice'))}>
              {t('auth.privacyPolicy')}
            </Text>
            .
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type AuthInputProps = React.ComponentProps<typeof TextInput> & {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  trailing?: React.ReactNode;
  inputRef?: React.RefObject<TextInputType | null>;
  testID?: string;
};

function AuthInput({ icon, trailing, inputRef, testID, ...props }: AuthInputProps) {
  return (
    <View style={styles.inputShell}>
      <Ionicons name={icon} size={24} color={colors.mutedDark} />
      <TextInput
        ref={inputRef}
        placeholderTextColor="#A0A8BC"
        style={styles.input}
        testID={testID}
        {...props}
      />
      {trailing}
    </View>
  );
}

function SocialButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.socialButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      testID="auth-google"
    >
      <Image
        source={require('../../assets/pinkeva/google.png')}
        style={styles.googleMark}
        resizeMode="contain"
      />
      <Text style={styles.socialLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  keyboardView: { flex: 1, backgroundColor: '#FFFFFF' },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 30 },
  container: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24 },
  brandWrap: { alignItems: 'center', marginBottom: 24 },
  taglineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  tagline: { color: colors.mutedDark, fontSize: 17 },
  languageButton: {
    minHeight: 36,
    marginTop: 12,
    borderRadius: 18,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F1F6FF',
  },
  languageButtonText: { color: colors.blue, fontSize: 14, fontWeight: '700' },
  segment: {
    height: 57,
    borderRadius: 18,
    backgroundColor: '#F4F6FA',
    flexDirection: 'row',
    padding: 3,
    marginBottom: 26,
  },
  segmentButton: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 15 },
  segmentButtonSelected: {
    backgroundColor: '#FFFFFF',
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.09,
    shadowRadius: 8,
    elevation: 2,
  },
  segmentLabel: { color: colors.text, fontSize: 17, fontWeight: '600' },
  segmentLabelSelected: { color: colors.blue, fontWeight: '800' },
  form: { gap: 14 },
  inputShell: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.small,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
  },
  input: { flex: 1, minHeight: 56, color: colors.text, fontSize: 17, outlineStyle: 'none' } as never,
  forgotButton: { alignSelf: 'flex-end', paddingVertical: 4, paddingLeft: 16 },
  forgotText: { color: colors.blue, fontSize: 15, fontWeight: '500' },
  primaryAction: { marginTop: 4 },
  secondaryAction: {
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: colors.blue,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryActionLabel: { color: colors.blue, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  demoPreview: { marginTop: 16, minHeight: 70, borderRadius: 16, borderWidth: 1, borderColor: '#F1D086', backgroundColor: '#FFF7E3', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 11 },
  demoPreviewIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFE7A8', alignItems: 'center', justifyContent: 'center' },
  demoPreviewCopy: { flex: 1, gap: 3 },
  demoPreviewTitle: { color: '#5F3D00', fontSize: 16, fontWeight: '800' },
  demoPreviewNote: { color: '#785A1E', fontSize: 11, lineHeight: 16 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginVertical: 22 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  orText: { color: colors.mutedDark, fontSize: 16 },
  socialStack: { gap: 12 },
  socialButton: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.small,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#FFFFFF',
  },
  socialLabel: { color: '#0C0D12', fontSize: 17, fontWeight: '500' },
  googleMark: { width: 28, height: 28 },
  configurationMessage: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 14,
    textAlign: 'center',
  },
  legalText: {
    marginTop: 26,
    color: colors.mutedDark,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  legalLink: { color: colors.blue, fontWeight: '600' },
  disabled: { opacity: 0.48 },
  pressed: { opacity: 0.68 },
});
