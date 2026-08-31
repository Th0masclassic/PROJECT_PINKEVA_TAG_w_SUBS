import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { OutlineButton, PrimaryButton, Surface } from '../components';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import type { ReleaseErrorCode } from '../provisioning/releaseErrors';

const releaseStatus: Record<string, string> = {
  searching: 'Looking for the selected tracker nearby…',
  connecting: 'Connecting to the tracker…',
  verifying: 'Verifying its serial number and finder identities…',
  authorizing: 'Confirming current-owner authorization…',
  erasing: 'Securely erasing both finder identities…',
  finalizing: 'Finalizing release with Pinkeva…',
};

const releaseErrors: Record<ReleaseErrorCode, string> = {
  authentication: 'Please sign in again before releasing this tracker.',
  permission: 'Bluetooth permission is required to verify and erase the tracker.',
  'bluetooth-off': 'Turn on Bluetooth, then try the secure release again.',
  platform: 'Secure tracker release requires the Pinkeva app on iPhone or Android.',
  configuration: 'The Pinkeva service is not configured for secure release.',
  'not-found': 'The selected tracker was not found. Keep it close and hold its maintenance button for five seconds, then retry.',
  unsupported: 'This tracker needs a firmware update or assisted recovery before it can be transferred.',
  recovery: 'The tracker did not confirm a complete secure erase. Contact support; it has not been removed from your account.',
  owner: 'Pinkeva could not verify this exact tracker and its current owner.',
  connection: 'The secure release was interrupted. Keep the tracker nearby and retry.',
  unavailable: 'The tracker could not be securely released. It remains on your account.',
};

export function ConfirmRemoveModal({
  visible,
  trackerName,
  secureRelease,
  phase = 'idle',
  error = null,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  trackerName: string;
  secureRelease: boolean;
  phase?: string;
  error?: ReleaseErrorCode | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const busy = phase !== 'idle' && phase !== 'error';
  const irreversible = phase === 'erasing' || phase === 'finalizing';
  const cancel = () => {
    if (!irreversible) onCancel();
  };
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={cancel}>
      <View style={styles.scrim}>
        <Pressable disabled={busy} onPress={cancel} style={StyleSheet.absoluteFill} />
        <Surface style={styles.card}>
          <View style={styles.iconCircle}>
            {busy ? (
              <ActivityIndicator color={colors.blue} />
            ) : (
              <Ionicons name={secureRelease ? 'shield-checkmark-outline' : 'trash-outline'} size={31} color={secureRelease ? colors.blue : colors.danger} />
            )}
          </View>
          <Text style={styles.title}>{t('tracker.removeConfirmTitle')}</Text>
          <Text style={styles.body}>
            {secureRelease
              ? `${trackerName} must be nearby. Pinkeva will verify its serial and your ownership, erase both finder identities, and only then remove it from your account.`
              : t('tracker.removeConfirmBody', { name: trackerName })}
          </Text>
          {secureRelease && !busy && !error ? (
            <Text style={styles.hint}>If Pinkeva cannot find it, hold the tracker’s maintenance button for five seconds and keep it close to this phone.</Text>
          ) : null}
          {busy ? (
            <View style={styles.statusCard} accessibilityLiveRegion="polite">
              <Text style={styles.statusText}>{releaseStatus[phase] ?? 'Secure release in progress…'}</Text>
            </View>
          ) : null}
          {error ? (
            <View style={styles.errorCard} accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
              <Text style={styles.errorText}>{releaseErrors[error]}</Text>
            </View>
          ) : null}
          <PrimaryButton
            label={error ? 'Try secure release again' : secureRelease ? 'Securely release tracker' : t('tracker.remove')}
            onPress={onConfirm}
            disabled={busy}
            testID="confirm-remove"
          />
          <OutlineButton
            label={irreversible ? 'Finishing secure release…' : busy ? 'Cancel release' : t('common.cancel')}
            disabled={irreversible}
            onPress={cancel}
          />
        </Surface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.48)', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 500, alignSelf: 'center', padding: 24, gap: 14 },
  iconCircle: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#FFF0F0', alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 25, fontWeight: '800' },
  body: { color: colors.muted, fontSize: 16, lineHeight: 23, marginBottom: 4 },
  hint: { color: colors.mutedDark, fontSize: 13, lineHeight: 19, padding: 12, borderRadius: 12, backgroundColor: colors.bluePale },
  statusCard: { padding: 13, borderRadius: 12, backgroundColor: colors.bluePale },
  statusText: { color: colors.blueDark, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  errorCard: { padding: 13, borderRadius: 12, backgroundColor: '#FFF0F0', flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 19, fontWeight: '700' },
});
