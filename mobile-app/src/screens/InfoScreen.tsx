import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import {
  Image,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AppSafeArea, BackHeader, OutlineButton, PrimaryButton, Surface, type IconName } from '../components';
import { useI18n, type TranslationKey } from '../i18n';
import {
  getAppPermissions,
  openAppPermissionSettings,
  requestAppPermission,
  type PermissionKey,
  type PermissionState,
} from '../permissions/appPermissions';
import { CloudPlusFeatures } from '../billing/CloudPlusFeatures';
import type { InfoTopic } from '../model';
import { colors, radii } from '../theme';

const connectTracker = require('../../assets/help/connect-tracker.png');
const firmwareUpdate = require('../../assets/help/firmware-update.png');

const topics: Record<InfoTopic, { title: TranslationKey; message: TranslationKey; icon: IconName }> = {
  account: { title: 'settings.account', message: 'settings.accountMessage', icon: 'person-circle-outline' },
  notifications: { title: 'settings.notifications', message: 'settings.notificationsMessage', icon: 'notifications-outline' },
  privacy: { title: 'settings.privacy', message: 'settings.privacyMessage', icon: 'shield-checkmark-outline' },
  permissions: { title: 'settings.permissions', message: 'settings.permissionsMessage', icon: 'lock-closed-outline' },
  support: { title: 'settings.help', message: 'settings.helpMessage', icon: 'help-circle-outline' },
  about: { title: 'settings.about', message: 'settings.aboutMessage', icon: 'information-circle-outline' },
  firmware: { title: 'settings.firmware', message: 'settings.firmwareMessage', icon: 'sync-outline' },
};

type HelpTab = 'start' | 'connect' | 'update' | 'cloud' | 'faq';

const helpTabs: { id: HelpTab; label: string }[] = [
  { id: 'start', label: 'Start here' },
  { id: 'connect', label: 'Connect' },
  { id: 'update', label: 'Update' },
  { id: 'cloud', label: 'Cloud +' },
  { id: 'faq', label: 'FAQ' },
];

const permissionLabels: Record<PermissionKey, { title: string; icon: IconName }> = {
  notifications: { title: 'System notifications', icon: 'notifications-outline' },
  location: { title: 'Location while using Pinkeva', icon: 'location-outline' },
  bluetooth: { title: 'Bluetooth', icon: 'bluetooth-outline' },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function TextBlock({ children }: { children: React.ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function PrivacyContent() {
  return (
    <>
      <Surface style={styles.heroCard}>
        <View style={styles.heroIcon}><Ionicons name="shield-checkmark-outline" color={colors.blue} size={34} /></View>
        <Text style={styles.heroTitle}>Privacy, with purpose</Text>
        <Text style={styles.heroBody}>Pinkeva is designed to help you look after your things—not to build a profile of you.</Text>
      </Surface>
      <Section title="What Pinkeva uses">
        <Surface style={styles.card}>
          <Bullet>Your account details keep your tracker, subscription, and support history connected to you.</Bullet>
          <Bullet>Tracker identifiers, status, and accepted location reports help show the right tag in the right place.</Bullet>
          <Bullet>Bluetooth is used only while you choose to set up, configure, or update a tag nearby.</Bullet>
        </Surface>
      </Section>
      <Section title="How it is protected">
        <Surface style={styles.card}>
          <Bullet>Sign-in sessions are stored in the phone’s protected storage.</Bullet>
          <Bullet>Pinkeva services use encrypted connections, and privileged Admin actions require additional verification.</Bullet>
          <Bullet>Firmware packages and nearby control commands are verified before a tag accepts them.</Bullet>
        </Surface>
      </Section>
      <Section title="Your choices">
        <Surface style={styles.card}>
          <TextBlock>Permissions are always under your control in the next Settings section. Location is requested when you use a location feature; it is not used as background advertising data.</TextBlock>
          <TextBlock>Pinkeva does not sell personal information or use your tracker history for advertising. Keep your account password private, enable multi-factor authentication when available, and contact support if you notice anything unfamiliar.</TextBlock>
        </Surface>
      </Section>
    </>
  );
}

function PermissionsContent({
  notificationDeliveryEnabled,
  onNotificationDeliveryChange,
}: {
  notificationDeliveryEnabled: boolean;
  onNotificationDeliveryChange: (enabled: boolean) => Promise<void>;
}) {
  const [permissions, setPermissions] = useState<PermissionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState<PermissionKey | 'delivery' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPermissions(await getAppPermissions());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const changePermission = async (permission: PermissionState) => {
    setChanging(permission.key);
    try {
      if (permission.status === 'allowed' || permission.status === 'settings') {
        await openAppPermissionSettings();
      } else {
        await requestAppPermission(permission.key);
      }
    } finally {
      setChanging(null);
      await reload();
    }
  };

  const changeDelivery = async () => {
    setChanging('delivery');
    try {
      await onNotificationDeliveryChange(!notificationDeliveryEnabled);
    } finally {
      setChanging(null);
    }
  };

  return (
    <>
      <Surface style={styles.heroCard}>
        <View style={styles.heroIcon}><Ionicons name="options-outline" color={colors.blue} size={34} /></View>
        <Text style={styles.heroTitle}>You are in control</Text>
        <Text style={styles.heroBody}>Pinkeva asks only for access that supports a feature you choose to use.</Text>
      </Surface>
      <Section title="Pinkeva delivery">
        <Surface style={styles.card}>
          <View style={styles.permissionTop}>
            <View style={styles.permissionIcon}><Ionicons name="notifications-outline" size={22} color={colors.blue} /></View>
            <View style={styles.permissionCopy}>
              <Text style={styles.permissionTitle}>Pinkeva notifications</Text>
              <Text style={styles.permissionDetail}>{notificationDeliveryEnabled ? 'On — account, tracker, and renewal updates can be delivered.' : 'Off — Pinkeva will stop delivering push notifications to this phone.'}</Text>
            </View>
          </View>
          <OutlineButton label={changing === 'delivery' ? 'Updating…' : notificationDeliveryEnabled ? 'Turn off' : 'Turn on'} onPress={() => void changeDelivery()} />
        </Surface>
      </Section>
      <Section title="System permissions">
        <Text style={styles.sectionHint}>Allow asks for access. Manage opens your phone settings, where you can change or disallow an existing permission at any time.</Text>
        <View style={styles.stack}>
          {(loading ? [] : permissions).map((permission) => {
            const label = permissionLabels[permission.key];
            const allowed = permission.status === 'allowed';
            const unavailable = permission.status === 'unavailable';
            const action = allowed || permission.status === 'settings' ? 'Manage' : permission.status === 'ask' ? 'Allow' : 'Open Settings';
            return (
              <Surface key={permission.key} style={styles.card}>
                <View style={styles.permissionTop}>
                  <View style={styles.permissionIcon}><Ionicons name={label.icon} size={22} color={colors.blue} /></View>
                  <View style={styles.permissionCopy}>
                    <View style={styles.permissionTitleRow}>
                      <Text style={styles.permissionTitle}>{label.title}</Text>
                      <Text style={[styles.statusPill, allowed && styles.statusPillAllowed]}>{allowed ? 'Allowed' : permission.status === 'ask' ? 'Ask' : permission.status === 'settings' ? 'Manage' : 'Off'}</Text>
                    </View>
                    <Text style={styles.permissionDetail}>{permission.detail}</Text>
                  </View>
                </View>
                {!unavailable ? <OutlineButton label={changing === permission.key ? 'Opening…' : action} onPress={() => void changePermission(permission)} /> : null}
              </Surface>
            );
          })}
          {loading ? <Surface style={styles.card}><Text style={styles.body}>Checking this phone’s current permission choices…</Text></Surface> : null}
        </View>
      </Section>
    </>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View>
      <View style={styles.stepCopy}><Text style={styles.stepTitle}>{title}</Text><Text style={styles.stepBody}>{children}</Text></View>
    </View>
  );
}

function HelpContent() {
  const [tab, setTab] = useState<HelpTab>('start');
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const selectTab = (next: HelpTab) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setTab(next);
  };
  const toggleFaq = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenFaq((current) => current === id ? null : id);
  };

  return (
    <>
      <Surface style={styles.helpIntro}>
        <Text style={styles.heroTitle}>A clear path, every time</Text>
        <Text style={styles.heroBody}>From unboxing to Pinkeva Cloud +, these quick guides keep the next step obvious.</Text>
      </Surface>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.helpTabs}>
        {helpTabs.map((item) => (
          <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }} onPress={() => selectTab(item.id)} style={[styles.helpTab, tab === item.id && styles.helpTabActive]}>
            <Text style={[styles.helpTabText, tab === item.id && styles.helpTabTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {tab === 'start' ? (
        <Surface style={styles.card}>
          <View style={styles.startIcon}><Ionicons name="sparkles-outline" size={32} color={colors.blue} /></View>
          <Text style={styles.cardTitle}>Your first Pinkeva tag</Text>
          <Text style={styles.body}>Keep the tag and your phone nearby. Turn on Bluetooth, sign in to Pinkeva, then choose Add tracker. The app will guide the rest, including a quick confirmation that the tag is ready.</Text>
          <View style={styles.divider} />
          <Bullet>Set a name you will recognise at a glance.</Bullet>
          <Bullet>Keep the tag close while connecting or installing an update.</Bullet>
          <Bullet>Use the tracker page whenever you need its exact status.</Bullet>
        </Surface>
      ) : null}
      {tab === 'connect' ? (
        <Surface style={styles.flowCard}>
          <Image source={connectTracker} resizeMode="cover" style={styles.flowImage} />
          <View style={styles.flowContent}>
            <Text style={styles.cardTitle}>Connect your tracker</Text>
            <Step number={1} title="Prepare">Turn on Bluetooth, keep your Pinkeva tag close, and open Trackers.</Step>
            <Step number={2} title="Add tracker">Choose Add tracker. When the app asks, hold the tag button as shown until the connection begins.</Step>
            <Step number={3} title="Confirm">Let Pinkeva verify the tag and finish setup. Give it a meaningful name, then check its tracker page.</Step>
          </View>
        </Surface>
      ) : null}
      {tab === 'update' ? (
        <Surface style={styles.flowCard}>
          <Image source={firmwareUpdate} resizeMode="cover" style={styles.flowImage} />
          <View style={styles.flowContent}>
            <Text style={styles.cardTitle}>Update safely</Text>
            <Step number={1} title="Check the tracker">Open a tracker and choose Firmware Update. Keep the tag close and the phone charged.</Step>
            <Step number={2} title="Stay nearby">Keep Pinkeva open while the verified update is sent. Do not move away or force-close the app.</Step>
            <Step number={3} title="Confirm success">Pinkeva checks that the tag reports the new version before showing the update as complete.</Step>
          </View>
        </Surface>
      ) : null}
      {tab === 'cloud' ? (
        <Surface style={styles.card}>
          <View style={styles.startIcon}><Ionicons name="cloud-outline" size={32} color={colors.blue} /></View>
          <Text style={styles.cardTitle}>Pinkeva Cloud +</Text>
          <Text style={styles.body}>Cloud + is managed through your Pinkeva account. Subscription changes are applied online, so there is no manual subscription update to send to a physical tracker.</Text>
          <View style={styles.divider} />
          <CloudPlusFeatures compact />
        </Surface>
      ) : null}
      {tab === 'faq' ? (
        <View style={styles.stack}>
          {[
            ['Why can’t I see my tag?', 'Refresh the Trackers screen and check the last-report time. Bluetooth is needed only for nearby setup, maintenance, and firmware updates; finder reports can arrive later when a compatible phone observes the tag.'],
            ['Do I need to update a tag after renewal?', 'No. Cloud + access is managed through your Pinkeva account and updates automatically after the backend confirms the renewal.'],
            ['What should I do if an update stops?', 'Keep the tag close, reopen Pinkeva, and start the update again from the tracker page. The tag verifies every update and will not accept an incomplete or unverified package.'],
            ['Can I turn permissions off later?', 'Yes. Use App Permissions to stop Pinkeva notification delivery or open your phone settings to change Bluetooth, location, or notification access.'],
          ].map(([question, answer]) => {
            const open = openFaq === question;
            return <Surface key={question} style={styles.faqCard}><Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => toggleFaq(question)} style={styles.faqHeader}><Text style={styles.faqQuestion}>{question}</Text><Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={21} color={colors.blue} /></Pressable>{open ? <Text style={styles.faqAnswer}>{answer}</Text> : null}</Surface>;
          })}
        </View>
      ) : null}
    </>
  );
}

function AboutContent() {
  return (
    <>
      <Surface style={styles.heroCard}>
        <View style={styles.heroIcon}><Ionicons name="heart-outline" color={colors.blue} size={34} /></View>
        <Text style={styles.heroTitle}>Keep what matters close</Text>
        <Text style={styles.heroBody}>Pinkeva is a calmer way to care for the things that carry your everyday life.</Text>
      </Surface>
      <Section title="Our point of view">
        <Surface style={styles.card}>
          <TextBlock>We believe safety technology should feel considered, not demanding. Pinkeva brings together a physical tracker, a clear mobile experience, and subscription-powered service so your essential things stay easier to find and easier to manage.</TextBlock>
          <TextBlock>Every screen is designed to answer one simple question: what should I do next? Whether you are connecting a new tag, checking its status, or renewing service, Pinkeva keeps the process clear and human.</TextBlock>
        </Surface>
      </Section>
      <Section title="What Pinkeva does">
        <Surface style={styles.card}>
          <Bullet>Helps you securely set up and manage your individual Pinkeva tags.</Bullet>
          <Bullet>Shows tracker, Cloud + membership, and accepted location information in one place.</Bullet>
          <Bullet>Keeps signed firmware and nearby tag-control operations verified before a tag accepts them.</Bullet>
        </Surface>
      </Section>
      <Section title="Made with care">
        <Surface style={styles.card}>
          <TextBlock>Pinkeva is built for real routines: keys by the door, a bag on the move, the objects you do not want to lose. We protect the trust behind those moments with purposeful data use, secure operations, and an experience that stays simple as your setup grows.</TextBlock>
        </Surface>
      </Section>
    </>
  );
}

function FirmwareContent() {
  return (
    <>
      <Surface style={styles.releaseHero}>
        <View>
          <Text style={styles.releaseEyebrow}>CURRENT STABLE RELEASE</Text>
          <Text style={styles.releaseVersion}>Pinkeva Tag 0.4.0</Text>
          <Text style={styles.releaseBody}>Dual Apple/Google identity provisioning with cloud-only subscription access.</Text>
        </View>
        <View style={styles.releaseIcon}><Ionicons name="shield-checkmark" size={32} color="#FFFFFF" /></View>
      </Surface>
      <Section title="What this release brings">
        <Surface style={styles.card}>
          <Bullet>Verified, signed firmware packages before installation.</Bullet>
          <Bullet>Rollback-aware update flow so a tag does not accept an incomplete update.</Bullet>
          <Bullet>One selected Apple or Google finder advertisement, restored after reboot.</Bullet>
          <Bullet>Cloud + account access without a manual tracker subscription sync.</Bullet>
          <Bullet>Clearer maintenance and recovery checks during sensitive tag operations.</Bullet>
        </Surface>
      </Section>
      <Section title="How to update a tracker">
        <Surface style={styles.card}>
          <TextBlock>Open the tracker you want to update, choose Firmware Update, and keep the tag near your phone until Pinkeva confirms the installed version. The release news lives here; the actual update always stays on the individual tracker so the right tag is verified.</TextBlock>
        </Surface>
      </Section>
      <Section title="Coming next">
        <Surface style={styles.card}>
          <TextBlock>Future releases will continue to improve the reliability of physical tag checks, secure delivery, and recovery guidance. Pinkeva will always show a release note before asking you to install a new version.</TextBlock>
        </Surface>
      </Section>
    </>
  );
}

function StandardContent({ topic }: { topic: InfoTopic }) {
  const { t } = useI18n();
  const content = topics[topic];
  return <Surface style={styles.heroCard}><View style={styles.heroIcon}><Ionicons name={content.icon} color={colors.blue} size={34} /></View><Text style={styles.heroTitle}>{t(content.title)}</Text><Text style={styles.heroBody}>{t(content.message)}</Text></Surface>;
}

export function InfoScreen({
  topic,
  onBack,
  notificationDeliveryEnabled = true,
  onNotificationDeliveryChange = async () => undefined,
}: {
  topic: InfoTopic;
  onBack: () => void;
  notificationDeliveryEnabled?: boolean;
  onNotificationDeliveryChange?: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const content = topics[topic];
  return (
    <AppSafeArea>
      <BackHeader title={t(content.title)} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {topic === 'privacy' ? <PrivacyContent /> : null}
        {topic === 'permissions' ? <PermissionsContent notificationDeliveryEnabled={notificationDeliveryEnabled} onNotificationDeliveryChange={onNotificationDeliveryChange} /> : null}
        {topic === 'support' ? <HelpContent /> : null}
        {topic === 'about' ? <AboutContent /> : null}
        {topic === 'firmware' ? <FirmwareContent /> : null}
        {topic === 'account' || topic === 'notifications' ? <StandardContent topic={topic} /> : null}
        <PrimaryButton label={t('common.done')} onPress={onBack} />
      </ScrollView>
    </AppSafeArea>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 5, paddingBottom: 36, gap: 20 },
  heroCard: { padding: 24, alignItems: 'center' },
  heroIcon: { width: 70, height: 70, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale, marginBottom: 16 },
  heroTitle: { color: colors.text, fontSize: 25, fontWeight: '800', textAlign: 'center' },
  heroBody: { color: colors.mutedDark, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 9 },
  section: { gap: 9 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800', paddingHorizontal: 2 },
  sectionHint: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 2 },
  card: { padding: 18, gap: 13 },
  body: { color: colors.mutedDark, fontSize: 15, lineHeight: 22 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  bulletDot: { width: 7, height: 7, borderRadius: 4, marginTop: 7, backgroundColor: colors.blue },
  bulletText: { flex: 1, color: colors.mutedDark, fontSize: 15, lineHeight: 22 },
  stack: { gap: 12 },
  permissionTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  permissionIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale },
  permissionCopy: { flex: 1, gap: 4 },
  permissionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  permissionTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  permissionDetail: { color: colors.mutedDark, fontSize: 13, lineHeight: 19 },
  statusPill: { overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 4, color: colors.mutedDark, backgroundColor: '#EEF0F5', fontSize: 10, fontWeight: '800' },
  statusPillAllowed: { color: colors.blue, backgroundColor: colors.bluePale },
  helpIntro: { padding: 22, alignItems: 'center' },
  helpTabs: { gap: 8, paddingRight: 20 },
  helpTab: { minHeight: 38, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  helpTabActive: { backgroundColor: colors.blue, borderColor: colors.blue },
  helpTabText: { color: colors.mutedDark, fontSize: 13, fontWeight: '700' },
  helpTabTextActive: { color: '#FFFFFF' },
  startIcon: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale, marginBottom: 5 },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 3 },
  flowCard: { overflow: 'hidden' },
  flowImage: { width: '100%', height: 210, backgroundColor: '#FBF7F4' },
  flowContent: { padding: 19, gap: 17 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue },
  stepNumberText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  stepCopy: { flex: 1, gap: 3 },
  stepTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  stepBody: { color: colors.mutedDark, fontSize: 14, lineHeight: 20 },
  faqCard: { padding: 0, overflow: 'hidden' },
  faqHeader: { minHeight: 62, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 10 },
  faqQuestion: { flex: 1, color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '800' },
  faqAnswer: { paddingHorizontal: 17, paddingBottom: 17, color: colors.mutedDark, fontSize: 14, lineHeight: 21 },
  releaseHero: { padding: 21, flexDirection: 'row', gap: 16, alignItems: 'center', backgroundColor: colors.navy },
  releaseEyebrow: { color: '#AFC7FF', fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  releaseVersion: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', marginTop: 6 },
  releaseBody: { flex: 1, color: '#D6E3FF', fontSize: 14, lineHeight: 20, marginTop: 7 },
  releaseIcon: { width: 62, height: 62, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue },
});
