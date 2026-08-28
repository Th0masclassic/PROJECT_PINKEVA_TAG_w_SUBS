import type { Session } from '@supabase/supabase-js';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { adminRequest, safeAdminMessage } from './src/api';
import { supabase } from './src/client';
import { Brand, PrimaryButton, SecondaryButton } from './src/components';
import { ADMIN_PUBLIC_CONFIG } from './src/config';
import { AdminDashboard } from './src/screens/AdminDashboard';
import { MfaScreen } from './src/screens/MfaScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { colors } from './src/theme';
import type { AdminIdentity } from './src/types';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AdminApp />
    </SafeAreaProvider>
  );
}

function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) { setReady(true); return undefined; }
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (active) { setSession(data.session); setReady(true); }
    }).catch(() => { if (active) setReady(true); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    const client = supabase;
    if (AppState.currentState === 'active') client.auth.startAutoRefresh();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    });
    return () => { listener.remove(); client.auth.stopAutoRefresh(); };
  }, []);

  const signIn = async (email: string, password: string) => {
    if (!supabase) return;
    setBusy(true); setMessage(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch {
      setMessage('Sign-in failed. Check the authorized account and try again.');
    } finally { setBusy(false); }
  };

  const signOut = useCallback(() => {
    setMessage(null);
    void supabase?.auth.signOut({ scope: 'local' });
  }, []);

  if (!ready) return <BootScreen label="Opening Pinkeva Admin…" />;
  if (!session || !supabase || !ADMIN_PUBLIC_CONFIG) {
    return <SignInScreen configured={Boolean(supabase && ADMIN_PUBLIC_CONFIG)} busy={busy} message={message} onSubmit={(email, password) => void signIn(email, password)} />;
  }
  return <SecurityGate sessionId={session.access_token} onSignOut={signOut} />;
}

function SecurityGate({ sessionId, onSignOut }: { sessionId: string; onSignOut: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [mfaReady, setMfaReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Checking account security…');
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [securityAttempt, setSecurityAttempt] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    setChecking(true); setMfaReady(false); setIdentity(null); setAccessError(null);
    void (async () => {
      try {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (!active) return;
        if (aal?.currentLevel === 'aal2') { setMfaReady(true); setChecking(false); return; }

        const { data: factors } = await supabase.auth.mfa.listFactors();
        if (!active) return;
        const verified = factors?.totp.find((factor) => factor.status === 'verified');
        if (verified) {
          setFactorId(verified.id);
          setMessage('Enter the six-digit code from your authenticator app.');
          setChecking(false);
          return;
        }

        for (const factor of factors?.totp ?? []) {
          if (factor.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
        const { data: enrollment, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Pinkeva Admin mobile' });
        if (error || !enrollment) throw error ?? new Error('MFA enrollment failed');
        if (!active) return;
        setFactorId(enrollment.id);
        setSecret(enrollment.totp.secret);
        setUri(enrollment.totp.uri);
        setMessage('Set up Pinkeva Admin in your authenticator app, then enter its six-digit code.');
      } catch {
        if (active) setMessage('MFA setup could not be started. Sign out and try again.');
      } finally { if (active) setChecking(false); }
    })();
    return () => { active = false; };
  }, [sessionId, securityAttempt]);

  useEffect(() => {
    if (!mfaReady || !supabase || !ADMIN_PUBLIC_CONFIG) return;
    let active = true;
    setChecking(true);
    void adminRequest<AdminIdentity>(supabase, ADMIN_PUBLIC_CONFIG.apiUrl, '/v1/admin/me')
      .then((result) => { if (active) setIdentity(result); })
      .catch((error) => { if (active) setAccessError(safeAdminMessage(error)); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [mfaReady, sessionId]);

  const verify = async (code: string) => {
    if (!supabase || !factorId) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      setMessage('That code was not accepted. Wait for a new code and try again.');
      setBusy(false);
      return;
    }
    await supabase.auth.refreshSession();
    setSecret(null); setUri(null); setMfaReady(true); setBusy(false);
  };

  if (checking) return <BootScreen label={mfaReady ? 'Verifying Admin access…' : 'Checking account security…'} />;
  if (!mfaReady) {
    return <MfaScreen factorReady={Boolean(factorId)} secret={secret} uri={uri} busy={busy} message={message} onVerify={(code) => void verify(code)} onSignOut={onSignOut} />;
  }
  if (!identity || !supabase || !ADMIN_PUBLIC_CONFIG) {
    return (
      <SafeAreaView style={styles.deniedSafeArea}>
        <View style={styles.deniedCard}>
          <View style={styles.deniedIcon}><Text style={styles.deniedMark}>!</Text></View>
          <Text style={styles.deniedTitle}>Access denied</Text>
          <Text style={styles.deniedBody}>{accessError || 'This account does not have active Pinkeva Admin access.'}</Text>
          <PrimaryButton label="Try again" onPress={() => setSecurityAttempt((attempt) => attempt + 1)} />
          <SecondaryButton label="Sign out" onPress={onSignOut} />
        </View>
      </SafeAreaView>
    );
  }
  return <AdminDashboard client={supabase} apiUrl={ADMIN_PUBLIC_CONFIG.apiUrl} identity={identity} onSignOut={onSignOut} />;
}

function BootScreen({ label }: { label: string }) {
  return (
    <SafeAreaView style={styles.bootSafeArea}>
      <View style={styles.bootContent}>
        <Brand admin />
        <ActivityIndicator size="large" color={colors.blue} style={styles.spinner} />
        <Text style={styles.bootLabel}>{label}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bootSafeArea: { flex: 1, backgroundColor: colors.background },
  bootContent: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  spinner: { marginTop: 30 },
  bootLabel: { marginTop: 14, color: colors.muted, fontSize: 15 },
  deniedSafeArea: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.background },
  deniedCard: { width: '100%', maxWidth: 460, alignSelf: 'center', gap: 13, padding: 25, borderWidth: 1, borderColor: colors.border, borderRadius: 24, backgroundColor: colors.surface },
  deniedIcon: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: '#FFF0F1' },
  deniedMark: { color: colors.danger, fontSize: 31, fontWeight: '900' },
  deniedTitle: { color: colors.text, fontSize: 29, fontWeight: '800' },
  deniedBody: { marginBottom: 8, color: colors.muted, fontSize: 15, lineHeight: 22 },
});
