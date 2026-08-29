import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  AppSafeArea,
  BackHeader,
  OutlineButton,
  PrimaryButton,
  SettingRow,
  StatusDot,
  Surface,
  TrackerArtwork,
} from '../components';
import { formatRelativeTime, useI18n } from '../i18n';
import { formatInterval, type Tracker, type TrackerKind } from '../model';
import { colors, radii, shadow } from '../theme';
import { useCloudPlusCopy } from '../billing/cloudPlusCopy';
import { useProtectionCopy } from '../premium/copy';
import { useTrackerCloudCopy } from '../trackers/copy';

const iconChoices: { kind: TrackerKind; labelKey: 'tracker.iconCard' | 'tracker.iconKeys' | 'tracker.iconBag' | 'tracker.iconCar' }[] = [
  { kind: 'card', labelKey: 'tracker.iconCard' },
  { kind: 'keys', labelKey: 'tracker.iconKeys' },
  { kind: 'backpack', labelKey: 'tracker.iconBag' },
  { kind: 'car', labelKey: 'tracker.iconCar' },
];

export function TrackerDetailScreen({
  tracker,
  onBack,
  onRename,
  onChangeIcon,
  premiumActive,
  premiumLoading,
  onOpenProtection,
  onOpenCloudPlus,
  onOpenInterval,
  onOpenFirmware,
  onRemove,
}: {
  tracker: Tracker;
  onBack: () => void;
  onRename: (name: string) => void;
  onChangeIcon: (kind: TrackerKind) => void;
  premiumActive: boolean;
  premiumLoading: boolean;
  onOpenProtection: () => void;
  onOpenCloudPlus: () => void;
  onOpenInterval: () => void;
  onOpenFirmware: () => void;
  onRemove: () => void;
}) {
  const { width } = useWindowDimensions();
  const { t } = useI18n();
  const cloudCopy = useCloudPlusCopy();
  const protectionCopy = useProtectionCopy();
  const trackerCloudCopy = useTrackerCloudCopy();
  const [renameVisible, setRenameVisible] = useState(false);
  const [iconVisible, setIconVisible] = useState(false);
  const [draftName, setDraftName] = useState(tracker.name);

  useEffect(() => {
    if (!premiumActive) setIconVisible(false);
  }, [premiumActive]);

  const saveName = () => {
    const trimmed = draftName.trim();
    if (trimmed) onRename(trimmed);
    setRenameVisible(false);
  };

  const iconLabel = t(
    iconChoices.find((choice) => choice.kind === tracker.kind)?.labelKey ?? 'tracker.iconCard',
  );

  return (
    <AppSafeArea>
      <BackHeader title={tracker.name} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="tracker-detail-screen">
        <Surface style={styles.productCard}>
          <TrackerArtwork kind={tracker.kind} style={styles.productArtwork} decorative carIconSize={112} />
          {tracker.status === 'nearby' ? (
            <StatusDot label={t('tracker.nearby')} />
          ) : (
            <View style={styles.awayRow}>
              <View style={styles.awayDot} />
              <Text style={styles.awayText}>{t('tracker.lastReported')}</Text>
            </View>
          )}
          <Text style={styles.lastSeen}>
            {t('tracker.lastSeenValue', { time: formatRelativeTime(t, tracker.lastSeen) })}
          </Text>
          {premiumActive ? (
            <View
              accessibilityLabel={`${cloudCopy.name}, ${cloudCopy.active}`}
              style={styles.cloudPill}
              testID="tracker-cloud-plus"
            >
              <Ionicons name="cloud" size={16} color={colors.blue} />
              <Text style={styles.cloudPillText}>{cloudCopy.name}</Text>
            </View>
          ) : null}
        </Surface>

        <Text style={styles.sectionLabel}>{t('tracker.settings')}</Text>
        <View style={styles.settingStack}>
          {tracker.source === 'local-preview' ? (
            <Surface style={[styles.settingCard, styles.localPreviewCard]}>
              <View style={styles.localPreviewIcon}>
                <Ionicons name="phone-portrait-outline" size={25} color={colors.blue} />
              </View>
              <View style={styles.localPreviewCopy}>
                <Text style={styles.localPreviewTitle}>{trackerCloudCopy.localTitle}</Text>
                <Text style={styles.localPreviewBody}>{trackerCloudCopy.localBody}</Text>
              </View>
            </Surface>
          ) : (
            <Surface style={styles.settingCard}>
              <SettingRow
                icon={premiumActive ? 'shield-checkmark-outline' : 'lock-closed-outline'}
                title={protectionCopy.title}
                subtitle={premiumActive ? protectionCopy.activeBody : protectionCopy.lockedBody}
                value={premiumLoading ? protectionCopy.loading : premiumActive ? cloudCopy.active : cloudCopy.locked}
                onPress={onOpenProtection}
                isLast
                testID="tracker-protection"
              />
            </Surface>
          )}
          <Surface style={styles.settingCard}>
            <SettingRow
              icon="pricetag-outline"
              title={t('tracker.name')}
              subtitle={t('tracker.nameSubtitle')}
              value={tracker.name}
              onPress={() => {
                setDraftName(tracker.name);
                setRenameVisible(true);
              }}
              isLast
              testID="rename-tracker"
            />
          </Surface>
          <Surface style={styles.settingCard}>
            <SettingRow
              icon={premiumActive ? 'images-outline' : 'lock-closed-outline'}
              title={t('tracker.icon')}
              subtitle={premiumActive ? t('tracker.iconSubtitle') : cloudCopy.iconLocked}
              value={premiumActive ? iconLabel : cloudCopy.locked}
              onPress={premiumActive ? () => setIconVisible(true) : onOpenCloudPlus}
              isLast
              testID="tracker-icon"
            />
          </Surface>
          <Surface style={styles.settingCard}>
            <SettingRow
              icon="timer-outline"
              title={t('tracker.interval')}
              subtitle={t('tracker.intervalSubtitle')}
              value={formatInterval(tracker.intervalMs)}
              onPress={onOpenInterval}
              isLast
              testID="advertising-interval"
            />
          </Surface>
          <Surface style={styles.settingCard}>
            <SettingRow
              icon="cloud-download-outline"
              title={t('tracker.softwareUpdate')}
              subtitle={t('tracker.softwareUpdateSubtitle')}
              value={tracker.firmwareUpdateVersion ? t('tracker.updateAvailable') : t('tracker.upToDate')}
              onPress={onOpenFirmware}
              isLast
              testID="software-update"
            />
          </Surface>
          <Surface style={styles.settingCard}>
            <SettingRow
              icon="trash-outline"
              title={t('tracker.remove')}
              subtitle={t('tracker.removeSubtitle')}
              danger
              onPress={onRemove}
              isLast
              testID="remove-tracker"
            />
          </Surface>
        </View>
      </ScrollView>

      <Modal transparent visible={renameVisible} animationType="fade" onRequestClose={() => setRenameVisible(false)}>
        <View style={styles.modalScrim}>
          <Pressable onPress={() => setRenameVisible(false)} style={StyleSheet.absoluteFill} />
          <Surface style={styles.renameCard}>
            <View style={styles.renameIcon}>
              <Ionicons name="pricetag-outline" size={28} color={colors.blue} />
            </View>
            <Text style={styles.renameTitle}>{t('tracker.renameTitle')}</Text>
            <Text style={styles.renameSubtitle}>{t('tracker.renameBody')}</Text>
            <TextInput
              autoFocus
              accessibilityLabel={t('tracker.name')}
              value={draftName}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              selectTextOnFocus
              style={styles.renameInput}
              testID="rename-input"
            />
            <PrimaryButton label={t('tracker.saveName')} onPress={saveName} testID="rename-save" />
            <OutlineButton label={t('common.cancel')} onPress={() => setRenameVisible(false)} />
          </Surface>
        </View>
      </Modal>

      <Modal transparent visible={premiumActive && iconVisible} animationType="slide" onRequestClose={() => setIconVisible(false)}>
        <View style={styles.iconScrim}>
          <Pressable onPress={() => setIconVisible(false)} style={StyleSheet.absoluteFill} />
          <SafeAreaView edges={['bottom']} style={styles.iconSheetSafe}>
            <View style={styles.iconSheet} testID="icon-picker">
              <View style={styles.sheetHandle} />
              <View style={styles.iconHeader}>
                <View style={styles.iconHeaderCopy}>
                  <Text style={styles.iconTitle}>{t('tracker.iconPickerTitle')}</Text>
                  <Text style={styles.iconBody}>{t('tracker.iconPickerBody')}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                  onPress={() => setIconVisible(false)}
                  style={styles.closeButton}
                >
                  <Ionicons name="close" size={26} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={[styles.iconGrid, width < 340 && styles.iconGridNarrow]}>
                {iconChoices.map((choice) => {
                  const selected = tracker.kind === choice.kind;
                  const label = t(choice.labelKey);
                  return (
                    <Pressable
                      key={choice.kind}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={
                        selected
                          ? t('a11y.iconSelected', { icon: label })
                          : t('a11y.chooseTrackerIcon', { icon: label })
                      }
                      onPress={() => {
                        onChangeIcon(choice.kind);
                        setIconVisible(false);
                      }}
                      style={({ pressed }) => [
                        styles.iconOption,
                        width < 340 && styles.iconOptionNarrow,
                        selected && styles.iconOptionSelected,
                        pressed && styles.pressed,
                      ]}
                      testID={`icon-option-${choice.kind}`}
                    >
                      <TrackerArtwork kind={choice.kind} style={styles.iconArtwork} decorative carIconSize={52} />
                      <Text style={[styles.iconOptionLabel, selected && styles.iconOptionLabelSelected]}>{label}</Text>
                      {choice.kind === 'card' ? <Text style={styles.defaultLabel}>{t('common.default')}</Text> : null}
                      {selected ? (
                        <View style={styles.selectedCheck}>
                          <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Text style={styles.defaultNote}>{t('tracker.iconDefaultNote')}</Text>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 30 },
  productCard: { minHeight: 350, padding: 24, alignItems: 'center', justifyContent: 'center' },
  productArtwork: { width: '100%', maxWidth: 410, height: 245 },
  awayRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  awayDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.muted },
  awayText: { color: colors.mutedDark, fontSize: 17, fontWeight: '600' },
  lastSeen: { color: colors.muted, fontSize: 17, marginTop: 10 },
  cloudPill: {
    minHeight: 30,
    borderRadius: 999,
    paddingHorizontal: 11,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bluePale,
  },
  cloudPillText: { color: colors.blueDark, fontSize: 12, fontWeight: '800' },
  sectionLabel: { color: colors.muted, fontSize: 19, fontWeight: '600', marginTop: 30, marginBottom: 14, marginLeft: 2 },
  settingStack: { gap: 14 },
  settingCard: { borderRadius: radii.medium, overflow: 'hidden' },
  localPreviewCard: { minHeight: 92, padding: 17, flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#F5F8FF' },
  localPreviewIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  localPreviewCopy: { flex: 1, gap: 4 },
  localPreviewTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  localPreviewBody: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  modalScrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.48)', justifyContent: 'center', padding: 24 },
  renameCard: { padding: 24, gap: 14, maxWidth: 500, width: '100%', alignSelf: 'center' },
  renameIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.bluePale, alignItems: 'center', justifyContent: 'center' },
  renameTitle: { color: colors.text, fontSize: 25, fontWeight: '800' },
  renameSubtitle: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  renameInput: { minHeight: 56, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 15, color: colors.text, fontSize: 17 },
  iconScrim: { flex: 1, backgroundColor: 'rgba(6,12,28,0.48)', justifyContent: 'flex-end' },
  iconSheetSafe: { maxHeight: '88%', backgroundColor: '#FFFFFF', borderTopLeftRadius: 30, borderTopRightRadius: 30 },
  iconSheet: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 14, backgroundColor: '#FFFFFF', borderTopLeftRadius: 30, borderTopRightRadius: 30 },
  sheetHandle: { position: 'absolute', top: 11, alignSelf: 'center', width: 46, height: 5, borderRadius: 3, backgroundColor: '#D0D5E0' },
  iconHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 18 },
  iconHeaderCopy: { flex: 1 },
  iconTitle: { color: colors.text, fontSize: 27, fontWeight: '800' },
  iconBody: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  closeButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F4F6FA', alignItems: 'center', justifyContent: 'center' },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingBottom: 10 },
  iconGridNarrow: { flexDirection: 'column' },
  iconOption: { width: '48%', minHeight: 166, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: '#FFFFFF', padding: 14, alignItems: 'center', justifyContent: 'center' },
  iconOptionNarrow: { width: '100%' },
  iconOptionSelected: { borderWidth: 2, borderColor: colors.blue, backgroundColor: '#F3F7FF', ...shadow },
  iconArtwork: { width: 112, height: 82 },
  iconOptionLabel: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 7 },
  iconOptionLabelSelected: { color: colors.blueDark },
  defaultLabel: { color: colors.muted, fontSize: 11, marginTop: 2 },
  selectedCheck: { position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  defaultNote: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
