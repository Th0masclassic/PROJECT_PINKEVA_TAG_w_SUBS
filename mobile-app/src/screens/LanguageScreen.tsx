import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, BackHeader, Brand, PrimaryButton } from '../components';
import { LANGUAGES, useI18n } from '../i18n';
import { colors, radii, shadow } from '../theme';

export function LanguageScreen({
  onboarding,
  onContinue,
  onBack,
}: {
  onboarding: boolean;
  onContinue: () => void;
  onBack?: () => void;
}) {
  const { language, setLanguage, t } = useI18n();

  return (
    <AppSafeArea style={styles.safeArea}>
      {onBack ? <BackHeader title={t('language.changeTitle')} onBack={onBack} /> : null}
      <View style={styles.container} testID="language-screen">
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {onboarding ? (
            <View style={styles.brandBlock}>
              <Brand />
              <LinearGradient
                colors={['#E9F1FF', '#F8FAFF']}
                style={styles.globeCircle}
              >
                <Ionicons name="language-outline" size={48} color={colors.blue} />
              </LinearGradient>
            </View>
          ) : null}

          <View style={styles.intro}>
            <Text style={styles.title}>
              {onboarding ? t('language.welcomeTitle') : t('language.changeTitle')}
            </Text>
            <Text style={styles.body}>
              {onboarding ? t('language.welcomeBody') : t('language.changeBody')}
            </Text>
            <Text style={styles.prompt}>{t('language.choosePrompt')}</Text>
          </View>

          <View style={styles.languageList} accessibilityRole="radiogroup">
            {LANGUAGES.map((option) => {
              const selected = language === option.code;
              return (
                <Pressable
                  key={option.code}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={t('a11y.chooseLanguage', {
                    language: option.nativeLabel,
                  })}
                  onPress={() => setLanguage(option.code)}
                  style={({ pressed }) => [
                    styles.languageRow,
                    selected && styles.languageRowSelected,
                    pressed && styles.pressed,
                  ]}
                  testID={`language-option-${option.code}`}
                >
                  <View style={[styles.radio, selected && styles.radioSelected]}>
                    {selected ? <View style={styles.radioDot} /> : null}
                  </View>
                  <View style={styles.languageCopy}>
                    <Text
                      accessibilityLanguage={option.code}
                      style={[styles.nativeName, selected && styles.nativeNameSelected]}
                    >
                      {option.nativeLabel}
                    </Text>
                    {option.englishLabel !== option.nativeLabel ? (
                      <Text style={styles.englishName}>{option.englishLabel}</Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <View style={styles.checkCircle}>
                      <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {onboarding ? (
            <View style={styles.changeLaterRow}>
              <Ionicons name="settings-outline" size={18} color={colors.mutedDark} />
              <Text style={styles.changeLater}>{t('language.changeLater')}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton
            label={t('language.continue')}
            icon="arrow-forward"
            onPress={onContinue}
            testID="language-continue"
          />
        </View>
      </View>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#FFFFFF' },
  container: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 20,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
  },
  brandBlock: { alignItems: 'center', gap: 8, marginBottom: 12 },
  globeCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  intro: { alignItems: 'center', marginBottom: 18 },
  title: { color: colors.text, fontSize: 31, lineHeight: 38, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.mutedDark, fontSize: 17, lineHeight: 24, textAlign: 'center', marginTop: 8 },
  prompt: { color: colors.text, fontSize: 18, fontWeight: '700', alignSelf: 'flex-start', marginTop: 22 },
  languageList: { gap: 10 },
  languageRow: {
    minHeight: 68,
    borderRadius: radii.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  languageRowSelected: { borderColor: colors.blue, borderWidth: 2, backgroundColor: '#F4F8FF', ...shadow },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  languageCopy: { flex: 1 },
  nativeName: { color: colors.text, fontSize: 18, fontWeight: '600' },
  nativeNameSelected: { color: colors.blueDark, fontWeight: '800' },
  englishName: { color: colors.muted, fontSize: 12, marginTop: 2 },
  checkCircle: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  changeLaterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18 },
  changeLater: { color: colors.mutedDark, fontSize: 14, textAlign: 'center' },
  footer: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 14, backgroundColor: '#FFFFFF', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
