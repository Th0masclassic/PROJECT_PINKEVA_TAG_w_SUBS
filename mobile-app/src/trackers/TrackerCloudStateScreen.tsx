import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AppSafeArea, Brand, PrimaryButton, TextButton } from '../components';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import type { OwnedTrackerErrorCode } from './cloud';
import { useTrackerCloudCopy } from './copy';

export function TrackerCloudStateScreen({
  status,
  error,
  onRetry,
  onSignOut,
}: {
  status: 'loading' | 'error';
  error: OwnedTrackerErrorCode | null;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const { t } = useI18n();
  const copy = useTrackerCloudCopy();
  const loading = status === 'loading';

  return (
    <AppSafeArea>
      <View style={styles.content} testID={`tracker-cloud-${status}`}>
        <Brand />
        {loading ? (
          <ActivityIndicator color={colors.blue} size="large" />
        ) : (
          <View style={styles.errorIcon}>
            <Ionicons name="cloud-offline-outline" color={colors.blue} size={42} />
          </View>
        )}
        <View style={styles.copy}>
          <Text style={styles.title}>{loading ? copy.loadingTitle : copy.errorTitle}</Text>
          <Text style={styles.body}>
            {loading
              ? copy.loadingBody
              : copy.errors[error ?? 'unavailable']}
          </Text>
        </View>
        {!loading ? (
          <View style={styles.actions}>
            <PrimaryButton label={copy.retry} onPress={onRetry} testID="tracker-cloud-retry" />
            <TextButton label={t('settings.signOut')} onPress={onSignOut} />
          </View>
        ) : null}
      </View>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 24,
  },
  errorIcon: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bluePale,
  },
  copy: { alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 25, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.mutedDark, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 5, marginTop: 4 },
});
