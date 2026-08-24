import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, BackHeader, PrimaryButton, Surface, TextButton, TrackerArtwork } from '../components';
import { useI18n } from '../i18n';
import type { Tracker } from '../model';
import { colors, radii } from '../theme';

export function IntervalScreen({
  tracker,
  onBack,
  onPressed,
}: {
  tracker: Tracker;
  onBack: () => void;
  onPressed: () => void;
}) {
  const { t } = useI18n();
  return (
    <AppSafeArea>
      <BackHeader title={t('interval.title')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="interval-screen">
        <View style={styles.timerCircle}>
          <View style={styles.timerArc} />
          <Text style={styles.timerText}>5s</Text>
        </View>

        <TrackerArtwork kind={tracker.kind} style={styles.cardArtwork} decorative carIconSize={105} />
        <Text style={styles.title}>{t('interval.pressTitle')}</Text>
        <Text style={styles.body}>{t('interval.pressBody', { name: tracker.name })}</Text>

        <Surface style={styles.helpCard}>
          <View style={styles.helpIcon}>
            <Ionicons name="information-circle-outline" color={colors.blue} size={34} />
          </View>
          <View style={styles.helpCopy}>
            <Text style={styles.helpTitle}>{t('interval.howTitle')}</Text>
            <Text style={styles.helpText}>{t('interval.howBody', { name: tracker.name })}</Text>
          </View>
          <View style={styles.helpMiniCard}>
            <TrackerArtwork kind={tracker.kind} style={styles.helpMiniArtwork} decorative carIconSize={35} />
            <Ionicons name="arrow-forward" size={30} color={colors.blue} style={styles.helpArrow} />
          </View>
        </Surface>

        <PrimaryButton label={t('interval.pressed')} onPress={onPressed} testID="interval-connect" />
        <TextButton label={t('common.cancel')} onPress={onBack} />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 24, alignItems: 'stretch' },
  timerCircle: { width: 76, height: 76, borderRadius: 38, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 7, borderColor: '#EEF1F6', marginTop: 12 },
  timerArc: { position: 'absolute', width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: 'transparent', borderTopColor: colors.blue, borderRightColor: colors.blue, transform: [{ rotate: '40deg' }] },
  timerText: { color: colors.blueDark, fontSize: 25, fontWeight: '800' },
  cardArtwork: { width: '100%', height: 300, marginTop: 6 },
  title: { color: colors.text, fontSize: 25, fontWeight: '800', textAlign: 'center', marginTop: 4 },
  body: { color: colors.mutedDark, fontSize: 16, lineHeight: 24, textAlign: 'center', marginTop: 12, marginBottom: 24 },
  helpCard: { minHeight: 132, borderRadius: radii.medium, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 28 },
  helpIcon: { width: 48 },
  helpCopy: { flex: 1 },
  helpTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  helpText: { color: colors.mutedDark, fontSize: 13, lineHeight: 19, marginTop: 5 },
  helpMiniCard: { width: 88, alignItems: 'center', justifyContent: 'center' },
  helpMiniArtwork: { width: 86, height: 64 },
  helpArrow: { position: 'absolute', left: -11, bottom: 4 },
});
