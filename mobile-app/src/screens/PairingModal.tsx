import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OutlineButton, PrimaryButton, TrackerArtwork } from '../components';
import { useI18n } from '../i18n';
import type { ConnectionOperation, PairingPhase, TrackerKind } from '../model';
import { colors, radii, shadow } from '../theme';

export function PairingModal({
  phase,
  operation = 'add',
  trackerName = 'Pinkeva Card',
  trackerKind = 'card',
  progress = 0,
  errorMessage,
  onRetry,
  onCancel,
}: {
  phase: PairingPhase;
  operation?: ConnectionOperation;
  trackerName?: string;
  trackerKind?: TrackerKind;
  progress?: number;
  errorMessage?: string;
  onRetry?: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const visible = phase !== 'idle';
  const connecting = phase === 'connecting';
  const installing = phase === 'installing';
  const success = phase === 'success';
  const failed = phase === 'error';
  const title = installing
    ? t('tracker.installing')
    : success
    ? operation === 'firmware'
      ? t('tracker.updateCompleted')
      : operation === 'add'
        ? t('pairing.foundTitle')
        : t('interval.title')
    : operation === 'firmware'
      ? t('tracker.softwareUpdate')
      : operation === 'interval'
        ? t('interval.title')
        : t('pairing.title');

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.scrim}>
        <Pressable accessibilityLabel={t('a11y.closePairing')} onPress={onCancel} style={StyleSheet.absoluteFill} />
        <SafeAreaView edges={['bottom']} style={styles.sheetSafeArea}>
          <View style={styles.sheet} testID="pairing-sheet">
            <View style={styles.handle} />
            <Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onCancel} style={styles.closeButton} testID="pairing-close">
              <Ionicons name="close" size={28} color={colors.text} />
            </Pressable>
            <ScrollView bounces={false} contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>
                {failed
                  ? errorMessage ?? t('pairing.errorGeneric')
                  : installing
                  ? t('tracker.installingNotice', { name: trackerName })
                  : success && operation === 'firmware'
                    ? t('tracker.updateCompletedNotice', { name: trackerName })
                    : success
                      ? t('pairing.readyBody', { name: trackerName })
                      : t('pairing.bringNearBody', { name: trackerName })}
              </Text>

              <View style={styles.artworkArea}>
                <View style={[styles.ring, styles.ringLarge, connecting && styles.ringConnecting]} />
                <View style={[styles.ring, styles.ringMedium, connecting && styles.ringConnecting]} />
                <View style={styles.bluetoothBadge}>
                  <LinearGradient colors={['#72A5FF', colors.blue]} style={styles.bluetoothGradient}>
                    <Ionicons
                      name={success ? 'checkmark' : failed ? 'alert' : installing ? 'cloud-download' : 'bluetooth'}
                      size={33}
                      color="#FFFFFF"
                    />
                  </LinearGradient>
                </View>
                {connecting ? <View style={styles.cardGlow} /> : null}
                <TrackerArtwork kind={trackerKind} style={styles.cardArtwork} decorative carIconSize={96} />
                <Text style={[styles.sparkle, styles.sparkleLeft]}>✦</Text>
                <Text style={[styles.sparkle, styles.sparkleRight]}>✧</Text>
              </View>

              <View style={styles.stateRow} accessibilityLiveRegion="polite">
                {success ? (
                  <Ionicons name="checkmark-circle" size={34} color={colors.blue} />
                ) : failed ? (
                  <Ionicons name="alert-circle" size={34} color="#C23B3B" />
                ) : (
                  <ActivityIndicator size="small" color={colors.blue} />
                )}
                <Text style={[styles.stateText, success && styles.successText, failed && styles.errorText]}>
                  {phase === 'searching'
                    ? t('pairing.searching')
                    : phase === 'connecting'
                      ? t('pairing.connecting')
                      : phase === 'installing'
                        ? `${t('tracker.installing')} ${Math.max(0, Math.min(100, Math.round(progress)))}%`
                        : failed
                          ? t('pairing.errorGeneric')
                        : operation === 'firmware'
                          ? t('tracker.updateCompleted')
                          : t('pairing.connected')}
                </Text>
              </View>

              {failed && onRetry ? (
                <PrimaryButton
                  label={t('pairing.retry')}
                  icon="refresh"
                  onPress={onRetry}
                  style={styles.retryButton}
                  testID="firmware-retry"
                />
              ) : null}
              <OutlineButton label={t('common.cancel')} onPress={onCancel} style={styles.cancelButton} testID="pairing-cancel" />
            </ScrollView>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.48)', justifyContent: 'flex-end' },
  sheetSafeArea: { height: '86%', backgroundColor: '#FFFFFF', borderTopLeftRadius: 32, borderTopRightRadius: 32 },
  sheet: { flex: 1, backgroundColor: '#FFFFFF', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingTop: 34 },
  sheetContent: { paddingHorizontal: 26, paddingTop: 26, paddingBottom: 18, alignItems: 'center' },
  handle: { position: 'absolute', top: 14, alignSelf: 'center', width: 46, height: 5, borderRadius: 3, backgroundColor: '#D0D5E0' },
  closeButton: { position: 'absolute', top: 24, right: 22, width: 48, height: 48, borderRadius: 24, backgroundColor: '#F6F7FA', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  title: { color: colors.text, fontSize: 31, fontWeight: '800', marginTop: 18, textAlign: 'center' },
  subtitle: { color: colors.mutedDark, fontSize: 18, lineHeight: 26, textAlign: 'center', marginTop: 14 },
  artworkArea: { height: 310, width: '100%', alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  ring: { position: 'absolute', borderRadius: radii.pill, backgroundColor: 'rgba(7,87,255,0.055)' },
  ringLarge: { width: 280, height: 280 },
  ringMedium: { width: 225, height: 225, backgroundColor: 'rgba(7,87,255,0.075)' },
  ringConnecting: { borderWidth: 2, borderColor: 'rgba(7,87,255,0.16)' },
  bluetoothBadge: { position: 'absolute', top: 26, zIndex: 5, ...shadow },
  bluetoothGradient: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  cardGlow: { position: 'absolute', width: 258, height: 168, borderRadius: 36, backgroundColor: 'rgba(7,87,255,0.22)', shadowColor: colors.blue, shadowOpacity: 0.5, shadowRadius: 22, shadowOffset: { width: 0, height: 0 } },
  cardArtwork: { width: 280, height: 205, marginTop: 38 },
  sparkle: { position: 'absolute', color: '#A9C5FF', fontSize: 26 },
  sparkleLeft: { left: 25, top: 90 },
  sparkleRight: { right: 22, top: 115 },
  stateRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  stateText: { color: colors.mutedDark, fontSize: 18, fontWeight: '500' },
  successText: { color: colors.blue, fontWeight: '700' },
  errorText: { color: '#A52F2F', fontWeight: '700' },
  retryButton: { alignSelf: 'stretch', marginTop: 20 },
  cancelButton: { alignSelf: 'stretch', marginTop: 24 },
});
