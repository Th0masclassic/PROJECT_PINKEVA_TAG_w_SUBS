import Ionicons from '@expo/vector-icons/Ionicons';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { adminRequest, safeAdminMessage } from '../api';
import {
  Badge,
  BottomNav,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  MenuRow,
  PrimaryButton,
  ScreenHeader,
  SecondaryButton,
  SectionIntro,
  Surface,
  Toast,
} from '../components';
import { colors, radii, shadow } from '../theme';
import type {
  AdminAssignment,
  AdminIdentity,
  AdminSection,
  Audit,
  MoreRoute,
  Overview,
  Plan,
  TrackerSummary,
  UserSummary,
  UserTrackers,
} from '../types';

type CommonProps = {
  client: SupabaseClient;
  apiUrl: string;
  refreshKey: number;
  showNotice: (message: string, error?: boolean) => void;
};

function confirmAction(title: string, message: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: destructive ? 'Confirm' : 'Continue', style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function AdminDashboard({
  client,
  apiUrl,
  identity,
  onSignOut,
}: {
  client: SupabaseClient;
  apiUrl: string;
  identity: AdminIdentity;
  onSignOut: () => void;
}) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [moreRoute, setMoreRoute] = useState<MoreRoute>('menu');
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const showNotice = useCallback((message: string, error = false) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice({ message, error });
    timer.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  const changeSection = (next: AdminSection) => {
    setSection(next);
    if (next !== 'more') setMoreRoute('menu');
  };

  const common = { client, apiUrl, refreshKey, showNotice };

  return (
    <View style={styles.app}>
      <SafeAreaView edges={['top']} style={styles.topSafeArea}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.compactBrand}>P I N K E V A</Text>
            <Text style={styles.compactAdmin}>ADMIN</Text>
          </View>
          <View style={styles.topActions}>
            <Badge label={identity.role} tone="navy" />
            <IconButton icon="refresh" label="Refresh current screen" onPress={() => setRefreshKey((value) => value + 1)} />
          </View>
        </View>
      </SafeAreaView>

      <View style={styles.content}>
        {section === 'overview' ? <OverviewScreen {...common} /> : null}
        {section === 'users' ? <UsersScreen {...common} identity={identity} /> : null}
        {section === 'plans' ? <PlansScreen {...common} /> : null}
        {section === 'more' && moreRoute === 'menu' ? (
          <MoreMenu
            identity={identity}
            onNavigate={setMoreRoute}
            onSignOut={() => void confirmAction('Sign out?', 'Your Admin session will be removed from this phone.', true).then((confirmed) => confirmed && onSignOut())}
          />
        ) : null}
        {section === 'more' && moreRoute === 'register' ? <RegisterScreen {...common} onBack={() => setMoreRoute('menu')} /> : null}
        {section === 'more' && moreRoute === 'admins' ? <AdminsScreen {...common} onBack={() => setMoreRoute('menu')} /> : null}
        {section === 'more' && moreRoute === 'audit' ? <AuditScreen {...common} onBack={() => setMoreRoute('menu')} /> : null}
      </View>

      <BottomNav active={section} onChange={changeSection} />
      <Toast message={notice?.message ?? null} error={notice?.error} />
    </View>
  );
}

function OverviewScreen({ client, apiUrl, refreshKey, showNotice }: CommonProps) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true); else if (!data) setLoading(true);
    try { setData(await adminRequest<Overview>(client, apiUrl, '/v1/admin/overview')); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setLoading(false); setRefreshing(false); }
  }, [apiUrl, client, data, showNotice]);

  useEffect(() => { void load(); }, [refreshKey]);
  const metrics = data ? [
    ['Accounts', data.users, 'people-outline'],
    ['Registered tags', data.devices, 'pricetag-outline'],
    ['Owned tags', data.owned_devices, 'link-outline'],
    ['Subscriptions', data.current_subscriptions, 'card-outline'],
    ['Ready to provision', data.available_devices, 'flash-outline'],
  ] as const : [];

  return (
    <ScrollView contentContainerStyle={styles.screen} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.blue} />}>
      <ScreenHeader title="Overview" subtitle="Secure operations at a glance" />
      {loading ? <LoadingState /> : (
        <>
          <View style={styles.metricGrid}>
            {metrics.map(([label, value, icon]) => (
              <Surface key={label} style={styles.metricCard}>
                <View style={styles.metricIcon}><Ionicons name={icon} size={21} color={colors.blue} /></View>
                <Text style={styles.metricValue}>{value}</Text>
                <Text style={styles.metricLabel}>{label}</Text>
              </Surface>
            ))}
          </View>
          <Surface style={styles.infoCard}>
            <View style={styles.infoIcon}><Ionicons name="shield-checkmark" size={25} color={colors.blue} /></View>
            <View style={styles.infoCopy}>
              <Text style={styles.cardTitle}>Protected by design</Text>
              <Text style={styles.cardBody}>Every operation is re-checked by the API using your Supabase session, Admin role, and MFA level. Privileged changes are written to the audit log.</Text>
            </View>
          </Surface>
        </>
      )}
    </ScrollView>
  );
}

function UsersScreen({ client, apiUrl, refreshKey, showNotice, identity }: CommonProps & { identity: AdminIdentity }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<UserTrackers | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (query = search, pull = false) => {
    if (pull) setRefreshing(true); else if (!users.length) setLoading(true);
    try {
      const [userRows, planRows] = await Promise.all([
        adminRequest<UserSummary[]>(client, apiUrl, `/v1/admin/users?limit=100&search=${encodeURIComponent(query)}`),
        adminRequest<Plan[]>(client, apiUrl, '/v1/admin/plans'),
      ]);
      setUsers(userRows);
      setPlans(planRows);
      setSelected((current) => current && userRows.some((user) => user.id === current.user.id) ? current : null);
    } catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setLoading(false); setRefreshing(false); }
  }, [apiUrl, client, search, showNotice, users.length]);

  useEffect(() => { void load(); }, [refreshKey]);

  const openUser = async (user: UserSummary) => {
    try { setSelected(await adminRequest<UserTrackers>(client, apiUrl, `/v1/admin/users/${user.id}/trackers`)); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
  };

  const grantAdmin = async (user: UserSummary) => {
    if (!await confirmAction('Grant administrator access?', `${user.display_name || user.email || 'This user'} will still need MFA before opening Admin.`)) return;
    try {
      await adminRequest(client, apiUrl, `/v1/admin/admins/${user.id}`, { method: 'POST' });
      showNotice('Administrator access granted.');
      await load();
    } catch (error) { showNotice(safeAdminMessage(error), true); }
  };

  if (selected) {
    const summary = users.find((user) => user.id === selected.user.id);
    return (
      <UserDetailScreen
        client={client}
        apiUrl={apiUrl}
        data={selected}
        plans={plans}
        protectedAccount={Boolean(summary?.is_admin)}
        onBack={() => setSelected(null)}
        onReload={async () => { if (summary) await openUser(summary); else setSelected(null); }}
        showNotice={showNotice}
      />
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(search, true)} tintColor={colors.blue} />}>
        <ScreenHeader title="Users" subtitle="Accounts, trackers, and access" />
        <View style={styles.searchRow}>
          <View style={styles.searchField}><Field label="Search accounts" icon="search-outline" value={search} onChangeText={setSearch} placeholder="Email, name, or user ID" returnKeyType="search" onSubmitEditing={() => void load(search)} /></View>
          <PrimaryButton label="Search" compact onPress={() => void load(search)} />
        </View>
        {loading ? <LoadingState /> : users.length === 0 ? <EmptyState icon="people-outline" title="No accounts found" body="Try another email, name, or user ID." /> : (
          <Surface>
            {users.map((user, index) => (
              <View key={user.id} style={[styles.userRow, index < users.length - 1 && styles.divider]}>
                <Pressable accessibilityRole="button" onPress={() => void openUser(user)} style={({ pressed }) => [styles.userOpen, pressed && styles.pressed]}>
                  <View style={styles.avatar}><Text style={styles.avatarText}>{(user.display_name || user.email || 'U').slice(0, 1).toUpperCase()}</Text></View>
                  <View style={styles.userCopy}>
                    <View style={styles.userNameRow}><Text numberOfLines={1} style={styles.userName}>{user.display_name || 'Unnamed user'}</Text>{user.is_admin ? <Badge label="Admin" /> : null}{user.account_status === 'banned' ? <Badge label="Banned" tone="danger" /> : null}</View>
                    <Text numberOfLines={1} style={styles.userEmail}>{user.email || user.id}</Text>
                    <Text style={styles.userMeta}>{user.tracker_count} tags · {user.subscription_count} subscriptions</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={22} color={colors.muted} />
                </Pressable>
                {!user.is_admin && identity.role === 'owner' ? <SecondaryButton label="Make admin" compact onPress={() => void grantAdmin(user)} /> : null}
              </View>
            ))}
          </Surface>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function UserDetailScreen({
  client,
  apiUrl,
  data,
  plans,
  protectedAccount,
  onBack,
  onReload,
  showNotice,
}: {
  client: SupabaseClient;
  apiUrl: string;
  data: UserTrackers;
  plans: Plan[];
  protectedAccount: boolean;
  onBack: () => void;
  onReload: () => Promise<void>;
  showNotice: (message: string, error?: boolean) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [messageTitle, setMessageTitle] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [banReason, setBanReason] = useState('');
  const [accessBusy, setAccessBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);
  const located = data.trackers.filter((tracker) => tracker.last_latitude !== null && tracker.last_longitude !== null);
  const region = useMemo(() => {
    if (!located.length) return null;
    const latitudes = located.map((tracker) => tracker.last_latitude as number);
    const longitudes = located.map((tracker) => tracker.last_longitude as number);
    const minLat = Math.min(...latitudes); const maxLat = Math.max(...latitudes);
    const minLng = Math.min(...longitudes); const maxLng = Math.max(...longitudes);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(.035, (maxLat - minLat) * 1.5),
      longitudeDelta: Math.max(.035, (maxLng - minLng) * 1.5),
    };
  }, [data.trackers]);

  const mutate = async (path: string, init: RequestInit, success: string) => {
    try { await adminRequest(client, apiUrl, path, init); showNotice(success); await onReload(); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
  };

  const sendMessage = async () => {
    const title = messageTitle.trim();
    const body = messageBody.trim();
    if (!title || !body) { showNotice('Add a notification title and message.', true); return; }
    if (!await confirmAction('Send this notification?', `Send “${title}” to this Pinkeva account?`)) return;
    setMessageBusy(true);
    try {
      await adminRequest(client, apiUrl, `/v1/admin/users/${data.user.id}/notifications`, { method: 'POST', body: JSON.stringify({ title, body }) });
      setMessageTitle(''); setMessageBody(''); showNotice('Notification queued for delivery.');
    } catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setMessageBusy(false); }
  };

  const updateAccess = async (banned: boolean) => {
    const reason = banReason.trim();
    if (banned && !reason) { showNotice('Add a short reason before suspending access.', true); return; }
    if (!await confirmAction(
      banned ? 'Suspend this account?' : 'Restore this account?',
      banned
        ? 'The customer will immediately lose Pinkeva API and tracker-data access. Billing history is kept.'
        : 'The customer can sign in and access their Pinkeva data again.',
      banned,
    )) return;
    setAccessBusy(true);
    try {
      await adminRequest(client, apiUrl, `/v1/admin/users/${data.user.id}/access`, { method: 'PATCH', body: JSON.stringify(banned ? { banned: true, reason } : { banned: false }) });
      setBanReason(''); showNotice(banned ? 'Account access suspended.' : 'Account access restored.'); await onReload();
    } catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setAccessBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void onReload().finally(() => setRefreshing(false)); }} tintColor={colors.blue} />}>
      <ScreenHeader title={data.user.display_name || 'Unnamed user'} subtitle={data.user.email || data.user.id} onBack={onBack} />
      <View style={styles.detailBadgeRow}><View style={styles.detailBadges}><Badge label={`${data.trackers.length} tracker${data.trackers.length === 1 ? '' : 's'}`} />{data.user.account_status === 'banned' ? <Badge label="Banned" tone="danger" /> : <Badge label="Active" tone="green" />}</View><Text style={styles.joinedText}>Joined {formatDate(data.user.created_at)}</Text></View>
      {!protectedAccount ? (
        <Surface style={styles.operatorCard}>
          <View style={styles.operatorHeader}><View style={styles.operatorIcon}><Ionicons name="megaphone-outline" size={23} color={colors.blue} /></View><View style={styles.operatorCopy}><Text style={styles.cardTitle}>Send notification</Text><Text style={styles.cardBody}>This appears in the customer’s Pinkeva inbox and is delivered to enabled phones.</Text></View></View>
          <View style={styles.formStack}><Field label="Title" value={messageTitle} onChangeText={setMessageTitle} maxLength={120} placeholder="A short, helpful title" /><Field label="Message" value={messageBody} onChangeText={setMessageBody} multiline maxLength={320} placeholder="What should the customer know?" /><PrimaryButton label={messageBusy ? 'Queuing…' : 'Send notification'} compact icon="send-outline" disabled={messageBusy || data.user.account_status === 'banned'} onPress={() => void sendMessage()} /></View>
        </Surface>
      ) : null}
      {!protectedAccount ? (
        <Surface style={data.user.account_status === 'banned' ? [styles.operatorCard, styles.restoreCard] : styles.operatorCard}>
          <View style={styles.operatorHeader}><View style={[styles.operatorIcon, data.user.account_status === 'banned' && styles.operatorIconDanger]}><Ionicons name={data.user.account_status === 'banned' ? 'lock-open-outline' : 'ban-outline'} size={23} color={data.user.account_status === 'banned' ? colors.danger : colors.blue} /></View><View style={styles.operatorCopy}><Text style={styles.cardTitle}>{data.user.account_status === 'banned' ? 'Restore account access' : 'Suspend account access'}</Text><Text style={styles.cardBody}>{data.user.account_status === 'banned' ? `Suspended ${formatDate(data.user.banned_at)}${data.user.ban_reason ? ` · ${data.user.ban_reason}` : ''}` : 'Suspension blocks customer API and tracker-data access without deleting their records.'}</Text></View></View>
          {data.user.account_status === 'banned' ? <SecondaryButton label={accessBusy ? 'Restoring…' : 'Restore access'} compact icon="lock-open-outline" disabled={accessBusy} onPress={() => void updateAccess(false)} /> : <View style={styles.formStack}><Field label="Reason for suspension" value={banReason} onChangeText={setBanReason} maxLength={240} placeholder="Required for the audit record" /><SecondaryButton label={accessBusy ? 'Suspending…' : 'Suspend account'} compact icon="ban-outline" danger disabled={accessBusy} onPress={() => void updateAccess(true)} /></View>}
        </Surface>
      ) : <Surface style={styles.protectedCard}><Text style={styles.cardTitle}>Protected administrator account</Text><Text style={styles.cardBody}>Administrator accounts are never suspended from this screen.</Text></Surface>}
      {region ? (
        <Surface style={styles.mapCard}>
          <MapView style={styles.map} initialRegion={region}>
            {located.map((tracker) => <Marker key={tracker.id} coordinate={{ latitude: tracker.last_latitude as number, longitude: tracker.last_longitude as number }} title={tracker.name || 'Pinkeva Tag'} description={tracker.last_place || 'Last accepted report'} />)}
          </MapView>
        </Surface>
      ) : <Surface><EmptyState icon="map-outline" title="No reported locations" body="This account’s tags do not have an accepted location report yet." /></Surface>}

      <View style={styles.trackerStack}>
        {data.trackers.map((tracker) => <TrackerCard key={tracker.id} tracker={tracker} plans={plans} onMutate={mutate} userId={data.user.id} />)}
        {data.trackers.length === 0 ? <Surface><EmptyState icon="pricetag-outline" title="No trackers" body="No active tracker ownerships belong to this account." /></Surface> : null}
      </View>
    </ScrollView>
  );
}

function TrackerCard({
  tracker,
  plans,
  userId,
  onMutate,
}: {
  tracker: TrackerSummary;
  plans: Plan[];
  userId: string;
  onMutate: (path: string, init: RequestInit, success: string) => Promise<void>;
}) {
  const activePlans = plans.filter((plan) => plan.active);
  const [planCode, setPlanCode] = useState(activePlans[0]?.code ?? '');
  const cancel = async () => {
    if (!tracker.subscription_id || !await confirmAction('End this subscription?', 'The subscription will end and Stripe cancellation will be queued when required.', true)) return;
    await onMutate(`/v1/admin/subscriptions/${tracker.subscription_id}`, { method: 'DELETE' }, 'Subscription ended.');
  };
  const grant = async () => {
    if (!planCode) return;
    const plan = activePlans.find((row) => row.code === planCode);
    if (!await confirmAction('Grant subscription?', `Grant ${plan?.name || planCode} to this tag?`)) return;
    await onMutate(`/v1/admin/users/${userId}/devices/${tracker.id}/subscriptions`, { method: 'POST', body: JSON.stringify({ plan_code: planCode }) }, 'Subscription granted.');
  };

  return (
    <Surface style={styles.trackerCard}>
      <View style={styles.trackerHeader}>
        <View style={styles.tagIcon}><Ionicons name="locate" size={23} color="#FFFFFF" /></View>
        <View style={styles.trackerCopy}>
          <Text style={styles.cardTitle}>{tracker.name || 'Pinkeva Tag'}</Text>
          <Text selectable style={styles.codeText}>{tracker.serial_number}</Text>
        </View>
        <Badge label={tracker.status || 'Unknown'} tone={tracker.status === 'active' ? 'green' : 'blue'} />
      </View>
      <View style={styles.factGrid}>
        <Fact label="Last place" value={tracker.last_place || 'No location yet'} />
        <Fact label="Last report" value={formatDate(tracker.last_location_at)} />
        <Fact label="Firmware" value={tracker.firmware_version || '—'} />
        <Fact label="Subscription" value={tracker.subscription_status ? `${tracker.plan_code} · ${tracker.subscription_status}` : 'None'} />
      </View>
      {tracker.subscription_id ? (
        <SecondaryButton label="End subscription" icon="close-circle-outline" danger onPress={() => void cancel()} />
      ) : (
        <View style={styles.subscriptionBox}>
          <Text style={styles.fieldLabel}>Choose a plan</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.planChips}>
            {activePlans.map((plan) => {
              const selected = plan.code === planCode;
              return <Pressable key={plan.code} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setPlanCode(plan.code)} style={[styles.planChip, selected && styles.planChipSelected]}><Text style={[styles.planChipText, selected && styles.planChipTextSelected]}>{plan.duration_months} mo · {(plan.price_cents / 100).toFixed(2)} {plan.currency}</Text></Pressable>;
            })}
          </ScrollView>
          <PrimaryButton label="Grant subscription" compact disabled={!planCode} onPress={() => void grant()} />
        </View>
      )}
    </Surface>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <View style={styles.fact}><Text style={styles.factLabel}>{label}</Text><Text style={styles.factValue}>{value}</Text></View>;
}

function PlansScreen({ client, apiUrl, refreshKey, showNotice }: CommonProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true); else if (!plans.length) setLoading(true);
    try { setPlans(await adminRequest<Plan[]>(client, apiUrl, '/v1/admin/plans')); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setLoading(false); setRefreshing(false); }
  }, [apiUrl, client, plans.length, showNotice]);
  useEffect(() => { void load(); }, [refreshKey]);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.blue} />}>
      <ScreenHeader title="Plans" subtitle="Per-tag subscription prices" />
      <SectionIntro title="Stripe price versions" body="Price changes apply to new purchases. Existing subscriptions keep their historical Stripe price." />
      {loading ? <LoadingState /> : <View style={styles.planStack}>{plans.map((plan) => <PlanEditor key={`${plan.code}:${plan.price_version}`} plan={plan} client={client} apiUrl={apiUrl} onDone={() => load()} showNotice={showNotice} />)}</View>}
    </ScrollView>
  );
}

function PlanEditor({ plan, client, apiUrl, onDone, showNotice }: { plan: Plan; client: SupabaseClient; apiUrl: string; onDone: () => Promise<void>; showNotice: (message: string, error?: boolean) => void }) {
  const [price, setPrice] = useState((plan.price_cents / 100).toFixed(2));
  const [currency, setCurrency] = useState(plan.currency.toUpperCase());
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const amount = Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(amount) || amount < 50 || !/^[A-Za-z]{3}$/.test(currency)) {
      showNotice('Enter a valid price and three-letter currency.', true); return;
    }
    if (!await confirmAction('Create a new Stripe price?', `Change ${plan.name} to ${price} ${currency.toUpperCase()} for new purchases?`)) return;
    setBusy(true);
    try {
      await adminRequest(client, apiUrl, `/v1/admin/plans/${encodeURIComponent(plan.code)}/price`, { method: 'PATCH', body: JSON.stringify({ amount_minor: amount, currency: currency.toUpperCase(), expected_version: plan.price_version }) });
      showNotice('Stripe price created and plan updated.');
      await onDone();
    } catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setBusy(false); }
  };
  return (
    <Surface style={styles.planCard}>
      <View style={styles.planTop}><View><Text style={styles.duration}>{plan.duration_months} MONTH{plan.duration_months === 1 ? '' : 'S'}</Text><Text style={styles.cardTitle}>{plan.name}</Text></View><Badge label={`v${plan.price_version}`} /></View>
      <Text style={styles.currentPrice}>{(plan.price_cents / 100).toFixed(2)} <Text style={styles.currency}>{plan.currency}</Text></Text>
      <View style={styles.priceFields}><View style={styles.priceField}><Field label="New price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" /></View><View style={styles.currencyField}><Field label="Currency" value={currency} onChangeText={(value) => setCurrency(value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} autoCapitalize="characters" maxLength={3} /></View></View>
      <PrimaryButton label={busy ? 'Saving…' : 'Create new Stripe price'} compact disabled={busy || !plan.provider_product_id} onPress={() => void save()} />
      <Text style={styles.providerNote}>{plan.provider_product_id ? 'Stripe product connected' : 'Configure the Stripe product in the backend first'}</Text>
    </Surface>
  );
}

function MoreMenu({ identity, onNavigate, onSignOut }: { identity: AdminIdentity; onNavigate: (route: MoreRoute) => void; onSignOut: () => void }) {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <ScreenHeader title="Admin tools" subtitle="Secure operational controls" />
      <Surface>
        <MenuRow icon="add-circle-outline" title="Register factory tag" subtitle="Create a device and one-time bootstrap payload" onPress={() => onNavigate('register')} />
        {identity.role === 'owner' ? <MenuRow icon="shield-outline" title="Administrators" subtitle="Grant or revoke Admin access" onPress={() => onNavigate('admins')} /> : null}
        <MenuRow icon="document-text-outline" title="Audit log" subtitle="Review privileged activity" onPress={() => onNavigate('audit')} />
        <MenuRow icon="log-out-outline" title="Sign out" subtitle="Remove this Admin session from the phone" danger onPress={onSignOut} />
      </Surface>
      <Surface style={styles.infoCard}>
        <View style={styles.infoIcon}><Ionicons name="phone-portrait-outline" size={24} color={colors.blue} /></View>
        <View style={styles.infoCopy}><Text style={styles.cardTitle}>Separate Admin app</Text><Text style={styles.cardBody}>Pinkeva Admin uses its own app identity and encrypted session. It does not add Admin controls to the customer Pinkeva app.</Text></View>
      </Surface>
    </ScrollView>
  );
}

function RegisterScreen({ client, apiUrl, showNotice, onBack }: CommonProps & { onBack: () => void }) {
  const [serial, setSerial] = useState('');
  const [name, setName] = useState('Pinkeva Tag');
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const normalized = serial.trim().toUpperCase();
    if (!/^PKV-[0-9A-F]{12}$/.test(normalized) || !name.trim()) { showNotice('Enter a valid PKV serial and display name.', true); return; }
    if (!await confirmAction('Register production tag?', `Register ${normalized} and create its one-time factory payload?`)) return;
    setBusy(true); setPayload(null);
    try {
      const result = await adminRequest<{ factory_payload: Record<string, unknown> }>(client, apiUrl, '/v1/admin/devices', { method: 'POST', body: JSON.stringify({ serial_number: normalized, name: name.trim() }) });
      setPayload(result.factory_payload); setSerial(''); showNotice('Tag registered. Save the one-time payload now.');
    } catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setBusy(false); }
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="Register tag" subtitle="Controlled factory enrollment" onBack={onBack} />
        <Surface style={styles.formCard}>
          <View style={styles.formIcon}><Ionicons name="hardware-chip-outline" size={27} color={colors.blue} /></View>
          <SectionIntro title="Register a factory tag" body="Creates the database device and encrypted bootstrap credential together." />
          <View style={styles.formStack}>
            <Field label="Serial number" icon="barcode-outline" placeholder="PKV-AABBCCDDEEFF" value={serial} onChangeText={(value) => setSerial(value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16))} autoCapitalize="characters" maxLength={16} />
            <Field label="Display name" icon="pricetag-outline" value={name} onChangeText={setName} maxLength={120} />
            <PrimaryButton label={busy ? 'Registering…' : 'Register tag securely'} icon="shield-checkmark" disabled={busy} onPress={() => void submit()} />
          </View>
        </Surface>
        {payload ? (
          <Surface style={styles.secretCard}>
            <View style={styles.warningIcon}><Ionicons name="warning" size={26} color={colors.danger} /></View>
            <SectionIntro title="One-time factory secret" body="Inject this payload into the matching ESP32 NVS in the controlled manufacturing environment. It will not be shown again." />
            <Text selectable style={styles.payload}>{JSON.stringify(payload, null, 2)}</Text>
            <View style={styles.formStack}><SecondaryButton label="Copy once" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(JSON.stringify(payload))} /><SecondaryButton label="Clear from screen" icon="trash-outline" danger onPress={() => setPayload(null)} /></View>
          </Surface>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function AdminsScreen({ client, apiUrl, refreshKey, showNotice, onBack }: CommonProps & { onBack: () => void }) {
  const [admins, setAdmins] = useState<AdminAssignment[]>([]);
  const [userId, setUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { setAdmins(await adminRequest<AdminAssignment[]>(client, apiUrl, '/v1/admin/admins')); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setLoading(false); }
  }, [apiUrl, client, showNotice]);
  useEffect(() => { void load(); }, [refreshKey]);
  const grant = async () => {
    if (!/^[0-9a-fA-F-]{36}$/.test(userId)) { showNotice('Enter a valid Supabase user UUID.', true); return; }
    if (!await confirmAction('Grant administrator access?', 'The account must still enable MFA before accessing data.')) return;
    try { await adminRequest(client, apiUrl, `/v1/admin/admins/${userId}`, { method: 'POST' }); setUserId(''); showNotice('Administrator granted.'); await load(); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
  };
  const revoke = async (admin: AdminAssignment) => {
    if (!await confirmAction('Revoke administrator?', `Immediately revoke ${admin.display_name || admin.email || admin.user_id}?`, true)) return;
    try { await adminRequest(client, apiUrl, `/v1/admin/admins/${admin.user_id}`, { method: 'DELETE' }); showNotice('Administrator revoked.'); await load(); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
  };
  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Administrators" subtitle="Owner-only access management" onBack={onBack} />
      <Surface style={styles.formCard}>
        <SectionIntro title="Grant administrator" body="Use the Supabase user UUID. MFA is still required." />
        <View style={styles.formStack}><Field label="User UUID" icon="person-add-outline" value={userId} onChangeText={setUserId} autoCapitalize="none" placeholder="00000000-0000-0000-0000-000000000000" /><PrimaryButton label="Grant access" compact onPress={() => void grant()} /></View>
      </Surface>
      {loading ? <LoadingState /> : <View style={styles.adminStack}>{admins.map((admin) => <Surface key={admin.id} style={styles.adminCard}><View style={styles.adminMain}><View style={styles.avatar}><Text style={styles.avatarText}>{(admin.display_name || admin.email || 'A').slice(0, 1).toUpperCase()}</Text></View><View style={styles.userCopy}><Text style={styles.userName}>{admin.display_name || 'Unnamed administrator'}</Text><Text style={styles.userEmail}>{admin.email || admin.user_id}</Text><Text style={styles.userMeta}>Granted {formatDate(admin.granted_at)}</Text></View></View><SecondaryButton label="Revoke access" compact danger onPress={() => void revoke(admin)} /></Surface>)}</View>}
    </ScrollView>
  );
}

function AuditScreen({ client, apiUrl, refreshKey, showNotice, onBack }: CommonProps & { onBack: () => void }) {
  const [rows, setRows] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true);
    try { setRows(await adminRequest<Audit[]>(client, apiUrl, '/v1/admin/audit?limit=200')); }
    catch (error) { showNotice(safeAdminMessage(error), true); }
    finally { setLoading(false); setRefreshing(false); }
  }, [apiUrl, client, showNotice]);
  useEffect(() => { void load(); }, [refreshKey]);
  return (
    <ScrollView contentContainerStyle={styles.screen} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.blue} />}>
      <ScreenHeader title="Audit log" subtitle="Append-only privileged activity" onBack={onBack} />
      {loading ? <LoadingState /> : rows.length === 0 ? <EmptyState icon="document-text-outline" title="No activity yet" body="Privileged mutations will appear here." /> : <View style={styles.auditStack}>{rows.map((row) => <Surface key={row.id} style={styles.auditCard}><View style={styles.auditTop}><Badge label={row.action} /><Text style={styles.auditTime}>{formatDate(row.created_at)}</Text></View><Fact label="Actor" value={row.actor_email || row.actor_user_id} /><Fact label="Target" value={`${row.target_type}${row.target_id ? ` · ${row.target_id}` : ''}`} /><Fact label="Request" value={row.request_id.slice(0, 8)} /></Surface>)}</View>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  app: { flex: 1, backgroundColor: colors.background },
  topSafeArea: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  topBar: { minHeight: 62, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  compactBrand: { color: colors.navy, fontSize: 16, fontWeight: '600', letterSpacing: 5 },
  compactAdmin: { marginTop: 2, color: colors.blue, fontSize: 8, fontWeight: '800', letterSpacing: 3 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  content: { flex: 1 },
  screen: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 18, paddingBottom: 32 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 11 },
  metricCard: { width: '48%', flexGrow: 1, minHeight: 146, padding: 18 },
  metricIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: colors.bluePale },
  metricValue: { marginTop: 14, color: colors.text, fontSize: 31, fontWeight: '800' },
  metricLabel: { marginTop: 3, color: colors.muted, fontSize: 13, lineHeight: 18 },
  infoCard: { marginTop: 18, padding: 18, flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
  infoIcon: { width: 45, height: 45, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: colors.bluePale },
  infoCopy: { flex: 1, minWidth: 0 },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  cardBody: { marginTop: 5, color: colors.muted, fontSize: 14, lineHeight: 20 },
  searchRow: { marginBottom: 16, gap: 10 },
  searchField: { flex: 1 },
  userRow: { paddingHorizontal: 13, paddingVertical: 10, gap: 8 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  userOpen: { minHeight: 75, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: colors.bluePale },
  avatarText: { color: colors.blue, fontSize: 20, fontWeight: '800' },
  userCopy: { flex: 1, minWidth: 0, gap: 3 },
  userNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  userName: { flexShrink: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  userEmail: { color: colors.muted, fontSize: 13 },
  userMeta: { color: colors.blue, fontSize: 12, fontWeight: '600' },
  detailBadgeRow: { marginBottom: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  detailBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, flex: 1 },
  joinedText: { flex: 1, color: colors.muted, fontSize: 12, textAlign: 'right' },
  operatorCard: { padding: 17, gap: 15, marginBottom: 15 },
  restoreCard: { borderColor: '#F2C6CA' },
  protectedCard: { padding: 17, gap: 5, marginBottom: 15, backgroundColor: colors.bluePale },
  operatorHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  operatorIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bluePale },
  operatorIconDanger: { backgroundColor: colors.dangerPale },
  operatorCopy: { flex: 1, minWidth: 0 },
  mapCard: { height: 250, marginBottom: 16 },
  map: { flex: 1 },
  trackerStack: { gap: 13 },
  trackerCard: { padding: 17 },
  trackerHeader: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  tagIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.blue },
  trackerCopy: { flex: 1, minWidth: 0, gap: 3 },
  codeText: { color: colors.muted, fontSize: 11 },
  factGrid: { marginVertical: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: { width: '47%', flexGrow: 1, minWidth: 130, gap: 3 },
  factLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .7 },
  factValue: { color: colors.text, fontSize: 13, lineHeight: 18 },
  fieldLabel: { color: colors.mutedDark, fontSize: 13, fontWeight: '700' },
  subscriptionBox: { gap: 10 },
  planChips: { gap: 8, paddingRight: 14 },
  planChip: { minHeight: 38, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, backgroundColor: colors.surface },
  planChipSelected: { borderColor: colors.blue, backgroundColor: colors.bluePale },
  planChipText: { color: colors.mutedDark, fontSize: 12, fontWeight: '600' },
  planChipTextSelected: { color: colors.blue },
  planStack: { gap: 13 },
  planCard: { padding: 18 },
  planTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  duration: { marginBottom: 6, color: colors.blue, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  currentPrice: { marginVertical: 15, color: colors.text, fontSize: 32, fontWeight: '800' },
  currency: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  priceFields: { marginBottom: 12, flexDirection: 'row', gap: 10 },
  priceField: { flex: 1 },
  currencyField: { width: 105 },
  providerNote: { marginTop: 10, color: colors.muted, fontSize: 12 },
  formCard: { padding: 19 },
  formIcon: { width: 50, height: 50, marginBottom: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: colors.bluePale },
  formStack: { gap: 13 },
  secretCard: { marginTop: 15, padding: 19, borderColor: '#F2C6CA' },
  warningIcon: { width: 50, height: 50, marginBottom: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: colors.dangerPale },
  payload: { maxHeight: 330, marginBottom: 14, padding: 14, borderRadius: radii.small, color: '#DCE8FF', backgroundColor: colors.navy, fontSize: 11, lineHeight: 17 },
  adminStack: { marginTop: 15, gap: 11 },
  adminCard: { padding: 15, gap: 12 },
  adminMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  auditStack: { gap: 11 },
  auditCard: { padding: 16, gap: 12 },
  auditTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  auditTime: { flex: 1, color: colors.muted, fontSize: 11, textAlign: 'right' },
  pressed: { opacity: .68 },
});
