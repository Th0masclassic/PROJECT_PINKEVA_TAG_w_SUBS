import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { OutlineButton, PrimaryButton, Surface } from '../components';
import { useI18n } from '../i18n';
import { colors } from '../theme';

export function ConfirmRemoveModal({
  visible,
  trackerName,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  trackerName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <Pressable onPress={onCancel} style={StyleSheet.absoluteFill} />
        <Surface style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="trash-outline" size={31} color={colors.danger} />
          </View>
          <Text style={styles.title}>{t('tracker.removeConfirmTitle')}</Text>
          <Text style={styles.body}>{t('tracker.removeConfirmBody', { name: trackerName })}</Text>
          <PrimaryButton label={t('tracker.remove')} onPress={onConfirm} testID="confirm-remove" />
          <OutlineButton label={t('common.cancel')} onPress={onCancel} />
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
});
