import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, BackHeader, PrimaryButton, Surface, TrackerArtwork } from '../components';
import { useI18n } from '../i18n';
import type { Tracker } from '../model';
import { colors, radii } from '../theme';

export function FirmwareUpdateScreen({
  tracker,
  onBack,
  onStartUpdate,
}: {
  tracker: Tracker;
  onBack: () => void;
  onStartUpdate: () => void;
}) {
  const { t } = useI18n();
  const updateAvailable = Boolean(tracker.firmwareUpdateVersion);

  return (
    <AppSafeArea>
      <BackHeader title={t('tracker.softwareUpdate')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="firmware-screen">
        <View style={[styles.stateIcon, updateAvailable ? styles.stateIconUpdate : styles.stateIconDone]}>
          <Ionicons
            name={updateAvailable ? 'cloud-download-outline' : 'checkmark'}
            size={38}
            color={updateAvailable ? colors.blue : '#178A54'}
          />
        </View>
        <Text style={styles.title}>
          {updateAvailable ? t('tracker.updateAvailable') : t('tracker.upToDate')}
        </Text>
        <Text style={styles.connectionNote}>{t('tracker.connectionOnDemand')}</Text>

        <Surface style={styles.deviceCard}>
          <TrackerArtwork kind={tracker.kind} style={styles.artwork} decorative carIconSize={78} />
          <View style={styles.deviceCopy}>
            <Text style={styles.deviceName}>{tracker.name}</Text>
            <View style={styles.versionRow}>
              <View style={styles.versionBlock}>
                <Text style={styles.versionLabel}>{t('tracker.currentVersion')}</Text>
                <Text style={styles.versionValue}>{tracker.firmwareVersion}</Text>
              </View>
              {tracker.firmwareUpdateVersion ? (
                <>
                  <Ionicons name="arrow-forward" size={22} color={colors.blue} />
                  <View style={styles.versionBlock}>
                    <Text style={styles.versionLabel}>{t('tracker.updateAvailable')}</Text>
                    <Text style={[styles.versionValue, styles.nextVersion]}>{tracker.firmwareUpdateVersion}</Text>
                  </View>
                </>
              ) : null}
            </View>
          </View>
        </Surface>

        <Surface style={styles.infoCard}>
          <View style={styles.infoIcon}>
            <Ionicons name="bluetooth" size={25} color={colors.blue} />
          </View>
          <Text style={styles.infoText}>{t('tracker.softwareUpdateSubtitle')}</Text>
        </Surface>

        <PrimaryButton
          label={updateAvailable ? t('tracker.connectAndUpdate') : t('common.done')}
          icon={updateAvailable ? 'cloud-download-outline' : 'checkmark-circle-outline'}
          onPress={updateAvailable ? onStartUpdate : onBack}
          testID={updateAvailable ? 'start-firmware-update' : 'firmware-done'}
        />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 26, alignItems: 'stretch' },
  stateIcon: { width: 78, height: 78, borderRadius: 39, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  stateIconUpdate: { backgroundColor: colors.bluePale },
  stateIconDone: { backgroundColor: '#EAF8F1' },
  title: { color: colors.text, fontSize: 29, fontWeight: '800', textAlign: 'center', marginTop: 16 },
  connectionNote: { color: colors.mutedDark, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, marginBottom: 22 },
  deviceCard: { borderRadius: radii.large, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
  artwork: { width: 112, height: 92 },
  deviceCopy: { flex: 1 },
  deviceName: { color: colors.text, fontSize: 21, fontWeight: '800' },
  versionRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14 },
  versionBlock: { flex: 1 },
  versionLabel: { color: colors.muted, fontSize: 11, lineHeight: 15 },
  versionValue: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 2 },
  nextVersion: { color: colors.blue },
  infoCard: { minHeight: 78, borderRadius: radii.medium, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, marginBottom: 24 },
  infoIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  infoText: { flex: 1, color: colors.mutedDark, fontSize: 14, lineHeight: 20 },
});
