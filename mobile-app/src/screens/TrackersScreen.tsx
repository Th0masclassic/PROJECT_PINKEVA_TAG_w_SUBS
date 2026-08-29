import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  AppSafeArea,
  PrimaryButton,
  ScreenTitle,
  Surface,
  TextButton,
  TrackerArtwork,
  TrackerRow,
} from '../components';
import { useI18n } from '../i18n';
import type { Tracker } from '../model';
import type { PremiumFeatureAccess } from '../premium/api';
import { colors, radii, shadow } from '../theme';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import { useTrackerCloudCopy } from '../trackers/copy';

export function TrackersScreen({
  trackers,
  mainTrackerId,
  premiumFeatures,
  onAdd,
  onOpenTracker,
  onSetMain,
  onNotice,
}: {
  trackers: Tracker[];
  mainTrackerId: string | null;
  premiumFeatures: Record<string, PremiumFeatureAccess>;
  onAdd: () => void;
  onOpenTracker: (trackerId: string) => void;
  onSetMain: (trackerId: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useI18n();
  const cloudCopy = useCloudPlusCopy();
  const trackerCloudCopy = useTrackerCloudCopy();

  return (
    <AppSafeArea>
      <View style={styles.container} testID="trackers-screen">
        <ScreenTitle
          title={t('trackers.title')}
          subtitle={t('trackers.subtitle')}
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('a11y.addTracker')}
              onPress={onAdd}
              style={({ pressed }) => [styles.addButton, shadow, pressed && styles.pressed]}
              testID="add-tracker-button"
            >
              <Ionicons name="add" size={38} color="#FFFFFF" />
            </Pressable>
          }
        />
        <View style={styles.divider} />

        {trackers.length ? (
          <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
            {trackers.map((tracker) => {
              const isMain = tracker.id === mainTrackerId;
              return (
                <Surface key={tracker.id} style={styles.trackerCard}>
                  <TrackerRow tracker={tracker} onPress={() => onOpenTracker(tracker.id)} />
                  {tracker.source === 'local-preview' ? (
                    <View
                      accessibilityLabel={`${trackerCloudCopy.localTitle}. ${trackerCloudCopy.localBody}`}
                      style={styles.localFooter}
                      testID={`local-preview-${tracker.id}`}
                    >
                      <Ionicons name="phone-portrait-outline" size={22} color={colors.blue} />
                      <View style={styles.localCopy}>
                        <Text style={styles.localTitle}>{trackerCloudCopy.localTitle}</Text>
                        <Text style={styles.localSubtitle}>{trackerCloudCopy.localBody}</Text>
                      </View>
                    </View>
                  ) : premiumFeatures[tracker.id]?.subscriptionActive ? (
                    <View
                      accessibilityLabel={`${cloudCopy.name}, ${cloudCopy.active}`}
                      style={styles.cloudIndicator}
                      testID={`cloud-plus-${tracker.id}`}
                    >
                      <View style={styles.cloudPill}>
                        <Ionicons name="cloud" size={16} color={colors.blue} />
                        <Text style={styles.cloudPillText}>{cloudCopy.name}</Text>
                      </View>
                    </View>
                  ) : null}
                  {isMain ? (
                    <View
                      accessibilityLabel={t('a11y.mainTracker', { name: tracker.name })}
                      style={styles.mainFooter}
                      testID={`main-tracker-${tracker.id}`}
                    >
                      <View style={styles.mainPill}>
                        <Ionicons name="star" size={15} color="#FFFFFF" />
                        <Text style={styles.mainPillText}>{t('trackers.mainBadge')}</Text>
                      </View>
                      <Text style={styles.mainHint}>{t('trackers.mainSubtitle')}</Text>
                    </View>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: false }}
                      accessibilityLabel={t('a11y.setMainTracker', { name: tracker.name })}
                      onPress={() => onSetMain(tracker.id)}
                      style={({ pressed }) => [styles.setMainButton, pressed && styles.pressed]}
                      testID={`set-main-${tracker.id}`}
                    >
                      <Ionicons name="star-outline" size={20} color={colors.blue} />
                      <Text style={styles.setMainText}>{t('trackers.setAsMain')}</Text>
                    </Pressable>
                  )}
                </Surface>
              );
            })}
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.emptyContent} showsVerticalScrollIndicator={false}>
            <View style={styles.artworkArea}>
              <View style={styles.artworkBlob} />
              <TrackerArtwork kind="card" style={styles.emptyArtwork} decorative />
              <Text style={[styles.sparkle, styles.sparkleOne]}>✦</Text>
              <Text style={[styles.sparkle, styles.sparkleTwo]}>✧</Text>
              <Text style={[styles.sparkle, styles.sparkleThree]}>✦</Text>
            </View>
            <Text style={styles.emptyTitle}>{t('trackers.emptyTitle')}</Text>
            <Text style={styles.emptyBody}>{t('trackers.emptyBody')}</Text>
            <PrimaryButton
              label={t('trackers.add')}
              icon="add-circle-outline"
              onPress={onAdd}
              testID="empty-add-tracker"
              style={styles.emptyPrimary}
            />
            <TextButton
              label={t('trackers.learn')}
              onPress={() => onNotice(t('trackers.learnNotice'))}
            />
          </ScrollView>
        )}
      </View>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  addButton: { width: 62, height: 62, borderRadius: 18, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  listContent: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 34, gap: 18 },
  trackerCard: { borderRadius: radii.large, overflow: 'hidden' },
  localFooter: { minHeight: 78, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#F5F8FF' },
  localCopy: { flex: 1, gap: 2 },
  localTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  localSubtitle: { color: colors.mutedDark, fontSize: 11, lineHeight: 16 },
  cloudIndicator: {
    minHeight: 46,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  cloudPill: {
    alignSelf: 'flex-start',
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bluePale,
  },
  cloudPillText: { color: colors.blueDark, fontSize: 12, fontWeight: '800' },
  mainFooter: { minHeight: 58, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: '#F5F8FF', paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 11 },
  mainPill: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: colors.blue, flexDirection: 'row', alignItems: 'center', gap: 6 },
  mainPillText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  mainHint: { flex: 1, color: colors.mutedDark, fontSize: 12, lineHeight: 17 },
  setMainButton: { minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  setMainText: { color: colors.blue, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  emptyContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingTop: 20, paddingBottom: 30 },
  artworkArea: { width: '100%', height: 280, alignItems: 'center', justifyContent: 'center' },
  artworkBlob: { position: 'absolute', width: 290, height: 235, borderRadius: 120, backgroundColor: colors.bluePale, transform: [{ rotate: '-7deg' }] },
  emptyArtwork: { width: 285, height: 210 },
  sparkle: { position: 'absolute', color: '#A9C5FF', fontSize: 30 },
  sparkleOne: { left: '14%', top: 115 },
  sparkleTwo: { right: '17%', top: 45 },
  sparkleThree: { right: '11%', bottom: 38, fontSize: 17 },
  emptyTitle: { color: colors.text, fontSize: 31, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontSize: 19, lineHeight: 29, textAlign: 'center', marginTop: 16 },
  emptyPrimary: { width: '100%', marginTop: 34, marginBottom: 16 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
});
