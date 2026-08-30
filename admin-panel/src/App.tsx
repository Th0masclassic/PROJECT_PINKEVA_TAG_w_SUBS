import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { adminRequest, safeAdminMessage } from './api';
import { GoogleUserMap } from './GoogleUserMap';
import type {
  AdminAssignment,
  AdminIdentity,
  Audit,
  Overview,
  Plan,
  UserSummary,
  UserTrackers,
} from './types';

type Config = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiUrl: string;
  googleMapsKey?: string;
  googleMapId?: string;
};

type Tab = 'overview' | 'users' | 'plans' | 'devices' | 'admins' | 'audit';

export function App({ client, config }: { client: SupabaseClient; config: Config }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => data.subscription.unsubscribe();
  }, [client]);

  if (!session) return <SignIn client={client} />;
  return <SecurityGate client={client} config={config} onSignOut={() => void client.auth.signOut()} />;
}

function SignIn({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const { error } = await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setMessage('Sign-in failed. Check the account and try again.');
  };

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">P</div>
        <p className="eyebrow">RESTRICTED OPERATIONS</p>
        <h1>Pinkeva Admin</h1>
        <p className="muted">Sign in with an authorized Supabase account. MFA is required before any data is shown.</p>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {message ? <p className="error" role="alert">{message}</p> : null}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Continue securely'}</button>
        <p className="security-note">Sessions are kept in memory only and are cleared when this tab closes.</p>
      </form>
    </main>
  );
}

function SecurityGate({
  client,
  config,
  onSignOut,
}: {
  client: SupabaseClient;
  config: Config;
  onSignOut: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('Checking account security…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!active) return;
      if (aal?.currentLevel === 'aal2') {
        setReady(true);
        return;
      }
      const { data: factors } = await client.auth.mfa.listFactors();
      if (!active) return;
      const verified = factors?.totp.find((factor) => factor.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        setMessage('Enter the 6-digit code from your authenticator app.');
        return;
      }
      const { data: enrollment, error } = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Pinkeva Admin',
      });
      if (!active) return;
      if (error || !enrollment) {
        setMessage('MFA setup could not be started. Sign out and try again.');
        return;
      }
      setFactorId(enrollment.id);
      setQr(enrollment.totp.qr_code);
      setMessage('Scan this code with an authenticator app, then enter its 6-digit code.');
    })();
    return () => { active = false; };
  }, [client]);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!factorId || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      setMessage('That code was not accepted. Wait for a new code and try again.');
      setCode('');
      setBusy(false);
      return;
    }
    await client.auth.refreshSession();
    setReady(true);
    setBusy(false);
  };

  if (ready) return <AdminDashboard client={client} config={config} onSignOut={onSignOut} />;
  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={verify}>
        <div className="shield">✓</div>
        <p className="eyebrow">MULTI-FACTOR AUTHENTICATION</p>
        <h1>Verify it’s you</h1>
        <p className="muted">{message}</p>
        {qr ? <img className="mfa-qr" src={qr} alt="Authenticator enrollment QR code" /> : null}
        {factorId ? <label>Authentication code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></label> : null}
        <button className="primary" disabled={busy || !factorId || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and open console'}</button>
        <button className="text-button" type="button" onClick={onSignOut}>Sign out</button>
      </form>
    </main>
  );
}

function AdminDashboard({ client, config, onSignOut }: { client: SupabaseClient; config: Config; onSignOut: () => void }) {
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void adminRequest<AdminIdentity>(client, config.apiUrl, '/v1/admin/me')
      .then((data) => { if (active) setIdentity(data); })
      .catch((error) => { if (active) setMessage(safeAdminMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, config.apiUrl, refresh]);

  if (loading) return <main className="auth-shell"><div className="auth-card"><div className="spinner" /><h1>Opening secure console…</h1></div></main>;
  if (!identity) return <main className="auth-shell"><div className="auth-card"><h1>Access denied</h1><p className="error">{message}</p><button className="primary" onClick={onSignOut}>Sign out</button></div></main>;

  const tabs: { id: Tab; label: string; mobileLabel: string }[] = [
    { id: 'overview', label: 'Overview', mobileLabel: 'Home' },
    { id: 'users', label: 'Users & trackers', mobileLabel: 'Users' },
    { id: 'plans', label: 'Plans & prices', mobileLabel: 'Plans' },
    { id: 'devices', label: 'Register tag', mobileLabel: 'Tags' },
    ...(identity.role === 'owner'
      ? [{ id: 'admins' as Tab, label: 'Administrators', mobileLabel: 'Admins' }]
      : []),
    { id: 'audit', label: 'Audit log', mobileLabel: 'Audit' },
  ];

  return (
    <div className="app-shell">
      <aside>
        <div className="sidebar-top">
          <div className="sidebar-brand"><span>P</span><div><strong>Pinkeva</strong><small>Admin Console</small></div></div>
          <div className="sidebar-footer"><span className="role-badge">{identity.role}</span><button onClick={onSignOut}>Sign out</button></div>
        </div>
        <nav aria-label="Admin sections">{tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} aria-label={item.label} onClick={() => setTab(item.id)}><span className="desktop-nav-label">{item.label}</span><span className="mobile-nav-label">{item.mobileLabel}</span></button>)}</nav>
      </aside>
      <main className="dashboard">
        <header><div><p className="eyebrow">SECURE OPERATIONS</p><h1>{tabs.find((item) => item.id === tab)?.label}</h1></div><button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></header>
        {message ? <div className="toast" role="status">{message}<button onClick={() => setMessage('')}>×</button></div> : null}
        {tab === 'overview' ? <OverviewPanel client={client} config={config} refresh={refresh} setMessage={setMessage} /> : null}
        {tab === 'users' ? <UsersPanel client={client} config={config} identity={identity} refresh={refresh} setMessage={setMessage} /> : null}
        {tab === 'plans' ? <PlansPanel client={client} config={config} refresh={refresh} setMessage={setMessage} /> : null}
        {tab === 'devices' ? <DevicesPanel client={client} config={config} setMessage={setMessage} /> : null}
        {tab === 'admins' && identity.role === 'owner' ? <AdminsPanel client={client} config={config} refresh={refresh} setMessage={setMessage} /> : null}
        {tab === 'audit' ? <AuditPanel client={client} config={config} refresh={refresh} setMessage={setMessage} /> : null}
      </main>
    </div>
  );
}

function OverviewPanel({ client, config, refresh, setMessage }: PanelProps) {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => { void adminRequest<Overview>(client, config.apiUrl, '/v1/admin/overview').then(setData).catch((error) => setMessage(safeAdminMessage(error))); }, [client, config.apiUrl, refresh, setMessage]);
  const cards = data ? [
    ['Accounts', data.users], ['Registered tags', data.devices], ['Owned tags', data.owned_devices],
    ['Current subscriptions', data.current_subscriptions], ['Ready to provision', data.available_devices],
  ] : [];
  return <section><div className="metric-grid">{cards.map(([label, value]) => <article className="metric" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div><article className="info-card"><h2>Security model</h2><p>Every privileged request is checked again by the API using the Supabase JWT, administrator role, and AAL2 MFA. Mutations are written to the append-only audit log. Browser clients never receive database, Stripe, or Supabase secret keys.</p></article></section>;
}

type PanelProps = { client: SupabaseClient; config: Config; refresh: number; setMessage: (value: string) => void };

function UsersPanel({ client, config, identity, refresh, setMessage }: PanelProps & { identity: AdminIdentity }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<UserTrackers | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const load = useCallback(async (query = search) => {
    try {
      const [userRows, planRows] = await Promise.all([
        adminRequest<UserSummary[]>(client, config.apiUrl, `/v1/admin/users?limit=100&search=${encodeURIComponent(query)}`),
        adminRequest<Plan[]>(client, config.apiUrl, '/v1/admin/plans'),
      ]);
      setUsers(userRows); setPlans(planRows);
      setSelected((current) => current && userRows.some((user) => user.id === current.user.id) ? current : null);
    } catch (error) { setMessage(safeAdminMessage(error)); }
  }, [client, config.apiUrl, search, setMessage]);
  useEffect(() => { void load(); }, [refresh]);

  const openUser = async (user: UserSummary) => {
    try { setSelected(await adminRequest<UserTrackers>(client, config.apiUrl, `/v1/admin/users/${user.id}/trackers`)); }
    catch (error) { setMessage(safeAdminMessage(error)); }
  };
  const grantAdmin = async (userId: string) => {
    if (!window.confirm('Grant administrator access to this user? They will still need MFA.')) return;
    try { await adminRequest(client, config.apiUrl, `/v1/admin/admins/${userId}`, { method: 'POST' }); setMessage('Administrator access granted.'); await load(); }
    catch (error) { setMessage(safeAdminMessage(error)); }
  };

  return <section className={`split-layout ${selected ? 'has-selection' : ''}`}>
    <div className="panel user-list-panel"><form className="search" onSubmit={(e) => { e.preventDefault(); void load(search); }}><input aria-label="Search accounts" placeholder="Search email, name, or user ID" value={search} onChange={(e) => setSearch(e.target.value)} /><button className="secondary">Search</button></form><div className="list">{users.map((user) => <div className={`list-row ${selected?.user.id === user.id ? 'selected' : ''}`} key={user.id}><button className="list-row-open" onClick={() => void openUser(user)}><span><strong>{user.display_name || 'Unnamed user'}</strong><small>{user.email || user.id}</small></span><span className="tracker-count">{user.tracker_count} tags</span></button><div className="row-meta">{user.is_admin ? <b>Admin</b> : identity.role === 'owner' ? <button className="mini" onClick={() => void grantAdmin(user.id)}>Make admin</button> : null}</div></div>)}{users.length === 0 ? <p className="list-empty">No accounts found.</p> : null}</div></div>
    <div className="panel detail-panel">{selected ? <><button className="mobile-back" onClick={() => setSelected(null)} aria-label="Back to accounts">← Accounts</button><UserDetail client={client} config={config} data={selected} plans={plans} reload={async () => { const user = users.find((row) => row.id === selected.user.id); if (user) await openUser(user); else setSelected(null); }} setMessage={setMessage} /></> : <div className="empty"><h2>Select an account</h2><p>Trackers, locations, and subscriptions will appear here.</p></div>}</div>
  </section>;
}

function UserDetail({ client, config, data, plans, reload, setMessage }: { client: SupabaseClient; config: Config; data: UserTrackers; plans: Plan[]; reload: () => Promise<void>; setMessage: (value: string) => void }) {
  const [chosenPlan, setChosenPlan] = useState(plans[0]?.code || '');
  const accountSubscription = data.subscription;
  useEffect(() => {
    if (!chosenPlan && plans[0]?.code) setChosenPlan(plans[0].code);
  }, [chosenPlan, plans]);
  const mutate = async (path: string, init: RequestInit, success: string) => {
    try { await adminRequest(client, config.apiUrl, path, init); setMessage(success); await reload(); }
    catch (error) { setMessage(safeAdminMessage(error)); }
  };
  return <div>
    <div className="detail-heading"><div><h2>{data.user.display_name || 'Unnamed user'}</h2><p>{data.user.email || data.user.id}</p></div><span>{data.trackers.length} trackers</span></div>
    <article className="account-subscription-card">
      <div><span className="duration">ACCOUNT SUBSCRIPTION</span><h3>{accountSubscription ? `${accountSubscription.plan_code} · ${accountSubscription.status}` : 'No current plan'}</h3><p>{accountSubscription ? `Covers every tracker on this account until ${new Date(accountSubscription.current_period_end).toLocaleDateString()}.` : 'One plan unlocks premium features on every tracker owned by this account.'}</p></div>
      {accountSubscription ? <button className="danger" onClick={() => { if (window.confirm('End this account subscription? Stripe cancellation will be queued when required.')) void mutate(`/v1/admin/subscriptions/${accountSubscription.id}`, { method: 'DELETE' }, 'Account subscription ended.'); }}>End subscription</button> : <div className="inline-form"><select value={chosenPlan} onChange={(e) => setChosenPlan(e.target.value)}>{plans.filter((plan) => plan.active).map((plan) => <option key={plan.code} value={plan.code}>{plan.duration_months} months · {(plan.price_cents / 100).toFixed(2)} {plan.currency}</option>)}</select><button className="primary small" disabled={!chosenPlan} onClick={() => void mutate(`/v1/admin/users/${data.user.id}/subscriptions`, { method: 'POST', body: JSON.stringify({ plan_code: chosenPlan }) }, 'Account subscription granted.')}>Grant subscription</button></div>}
    </article>
    <GoogleUserMap trackers={data.trackers} apiKey={config.googleMapsKey} mapId={config.googleMapId} />
    <div className="tracker-grid">{data.trackers.map((tracker) => <article className="tracker-card" key={tracker.id}><div className="tracker-head"><div className="tag-icon">⌖</div><div><h3>{tracker.name || 'Pinkeva Tag'}</h3><code>{tracker.serial_number}</code></div></div><dl><div><dt>Status</dt><dd>{tracker.status || '—'}</dd></div><div><dt>Last place</dt><dd>{tracker.last_place || 'No location yet'}</dd></div><div><dt>Firmware</dt><dd>{tracker.firmware_version || '—'}</dd></div></dl></article>)}</div>
  </div>;
}

function PlansPanel({ client, config, refresh, setMessage }: PanelProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const load = useCallback(() => adminRequest<Plan[]>(client, config.apiUrl, '/v1/admin/plans').then(setPlans).catch((error) => setMessage(safeAdminMessage(error))), [client, config.apiUrl, setMessage]);
  useEffect(() => { void load(); }, [refresh]);
  return <section><div className="section-intro"><h2>Account subscription prices</h2><p>A price change creates a new immutable Stripe Price for new purchases. Existing subscriptions keep their historical Stripe price.</p></div><div className="plan-grid">{plans.map((plan) => <PlanEditor key={plan.code} plan={plan} client={client} config={config} onDone={load} setMessage={setMessage} />)}</div></section>;
}

function PlanEditor({ plan, client, config, onDone, setMessage }: { plan: Plan; client: SupabaseClient; config: Config; onDone: () => Promise<void> | void; setMessage: (value: string) => void }) {
  const [price, setPrice] = useState((plan.price_cents / 100).toFixed(2));
  const [currency, setCurrency] = useState(plan.currency);
  const save = async () => {
    const amount = Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(amount) || amount < 50) { setMessage('Enter a valid price of at least 0.50.'); return; }
    if (!window.confirm(`Change ${plan.name} to ${price} ${currency.toUpperCase()} for new purchases?`)) return;
    try { await adminRequest(client, config.apiUrl, `/v1/admin/plans/${encodeURIComponent(plan.code)}/price`, { method: 'PATCH', body: JSON.stringify({ amount_minor: amount, currency: currency.toUpperCase(), expected_version: plan.price_version }) }); setMessage('Stripe price created and plan updated.'); await onDone(); }
    catch (error) { setMessage(safeAdminMessage(error)); }
  };
  return <article className="plan-card"><span className="duration">{plan.duration_months} MONTH{plan.duration_months === 1 ? '' : 'S'}</span><h3>{plan.name}</h3><p>Current: <strong>{(plan.price_cents / 100).toFixed(2)} {plan.currency}</strong></p><div className="price-form"><input type="number" min="0.50" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div><button className="primary small" disabled={!plan.provider_product_id} onClick={() => void save()}>Create new Stripe price</button><small>Version {plan.price_version} · {plan.provider_product_id ? 'Stripe connected' : 'Configure product in backend env first'}</small></article>;
}

function DevicesPanel({ client, config, setMessage }: Omit<PanelProps, 'refresh'>) {
  const [serial, setSerial] = useState(''); const [name, setName] = useState('Pinkeva Tag'); const [payload, setPayload] = useState<Record<string, unknown> | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); if (!window.confirm(`Register ${serial.toUpperCase()} in the production database?`)) return; setBusy(true); setPayload(null); try { const result = await adminRequest<{ factory_payload: Record<string, unknown> }>(client, config.apiUrl, '/v1/admin/devices', { method: 'POST', body: JSON.stringify({ serial_number: serial.toUpperCase(), name }) }); setPayload(result.factory_payload); setSerial(''); setMessage('Tag registered. Save the one-time factory payload now.'); } catch (error) { setMessage(safeAdminMessage(error)); } finally { setBusy(false); } };
  return <section className="form-layout"><form className="panel form-card" onSubmit={submit}><h2>Register a factory tag</h2><p>Creates the database device and an encrypted bootstrap credential together.</p><label>Serial number<input placeholder="PKV-AABBCCDDEEFF" pattern="PKV-[0-9A-Fa-f]{12}" value={serial} onChange={(e) => setSerial(e.target.value)} required /></label><label>Display name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required /></label><button className="primary" disabled={busy}>{busy ? 'Registering…' : 'Register tag securely'}</button></form>{payload ? <article className="panel secret-card"><div className="warning-icon">!</div><h2>One-time factory secret</h2><p>Inject this payload into the matching ESP32 NVS in the controlled manufacturing environment. It is not stored in the audit log and will not be shown again.</p><pre>{JSON.stringify(payload, null, 2)}</pre><button className="secondary" onClick={() => void navigator.clipboard.writeText(JSON.stringify(payload))}>Copy once</button><button className="danger" onClick={() => setPayload(null)}>Clear from screen</button></article> : <article className="panel info-card"><h2>Before registering</h2><ul><li>Confirm the serial printed by the firmware.</li><li>Use a private manufacturing workstation.</li><li>Enable secure boot and flash/NVS encryption.</li><li>Never send the bootstrap key by email or chat.</li></ul></article>}</section>;
}

function AdminsPanel({ client, config, refresh, setMessage }: PanelProps) {
  const [admins, setAdmins] = useState<AdminAssignment[]>([]); const [userId, setUserId] = useState('');
  const load = useCallback(() => adminRequest<AdminAssignment[]>(client, config.apiUrl, '/v1/admin/admins').then(setAdmins).catch((error) => setMessage(safeAdminMessage(error))), [client, config.apiUrl, setMessage]);
  useEffect(() => { void load(); }, [refresh]);
  const grant = async (e: FormEvent) => { e.preventDefault(); if (!window.confirm('Grant administrator access to this user?')) return; try { await adminRequest(client, config.apiUrl, `/v1/admin/admins/${userId}`, { method: 'POST' }); setUserId(''); setMessage('Administrator granted.'); await load(); } catch (error) { setMessage(safeAdminMessage(error)); } };
  const revoke = async (id: string) => { if (!window.confirm('Revoke this administrator immediately?')) return; try { await adminRequest(client, config.apiUrl, `/v1/admin/admins/${id}`, { method: 'DELETE' }); setMessage('Administrator revoked.'); await load(); } catch (error) { setMessage(safeAdminMessage(error)); } };
  return <section><form className="panel admin-grant" onSubmit={grant}><div><h2>Grant administrator</h2><p>Use the Supabase user UUID. The account must enable TOTP MFA before accessing data.</p></div><input aria-label="Supabase user UUID" placeholder="User UUID" pattern="[0-9a-fA-F-]{36}" value={userId} onChange={(e) => setUserId(e.target.value)} required /><button className="primary small">Grant</button></form><div className="panel table-wrap"><table><thead><tr><th>Administrator</th><th>Granted</th><th /></tr></thead><tbody>{admins.map((admin) => <tr key={admin.id}><td data-label="Admin"><strong>{admin.display_name || 'Unnamed user'}</strong><small>{admin.email || admin.user_id}</small></td><td data-label="Granted">{new Date(admin.granted_at).toLocaleString()}</td><td className="table-action"><button className="danger small" onClick={() => void revoke(admin.user_id)}>Revoke</button></td></tr>)}</tbody></table></div></section>;
}

function AuditPanel({ client, config, refresh, setMessage }: PanelProps) {
  const [rows, setRows] = useState<Audit[]>([]);
  useEffect(() => { void adminRequest<Audit[]>(client, config.apiUrl, '/v1/admin/audit?limit=200').then(setRows).catch((error) => setMessage(safeAdminMessage(error))); }, [client, config.apiUrl, refresh, setMessage]);
  return <section><div className="section-intro"><h2>Privileged activity</h2><p>Append-only records of administrative mutations. Secrets are intentionally excluded.</p></div><div className="panel table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Request</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td data-label="Time">{new Date(row.created_at).toLocaleString()}</td><td data-label="Actor">{row.actor_email || row.actor_user_id}</td><td data-label="Action"><code>{row.action}</code></td><td data-label="Target">{row.target_type}<small>{row.target_id}</small></td><td data-label="Request"><code>{row.request_id.slice(0, 8)}</code></td></tr>)}</tbody></table></div></section>;
}
