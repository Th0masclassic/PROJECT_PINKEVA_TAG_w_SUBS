import type { SupabaseClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';

import { safeAuthFeedback, type AuthErrorContext } from './authErrors';
import {
  performNativeAppleSignIn,
  subscribeToAppleCredentialRevocation,
} from './appleSignIn';
import { AUTH_RESET_PATH } from './config';
import {
  exchangeAuthCallback,
  launchGoogleOAuth,
  makeAuthEmailRedirectUri,
  parseAuthCallbackUrl,
} from './oauth';
import { supabase } from './supabase';
import type {
  AuthContextValue,
  AuthFeedback,
  AuthOperation,
  EmailAuthInput,
} from './types';

const AuthContext = createContext<AuthContextValue | null>(null);

function configuredClient(): SupabaseClient {
  if (!supabase) {
    const error = new Error('Authentication is not configured') as Error & { code: string };
    error.code = 'auth_not_configured';
    throw error;
  }
  return supabase;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthContextValue['session']>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<AuthOperation | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState<AuthFeedback | null>(null);
  const busyRef = useRef<AuthOperation | null>(null);
  const handledCallbacks = useRef(new Set<string>());

  const runOperation = useCallback(
    async (
      operation: AuthOperation,
      context: AuthErrorContext,
      work: (client: SupabaseClient) => Promise<AuthFeedback>,
    ): Promise<AuthFeedback> => {
      if (busyRef.current) return { kind: 'silent' };
      busyRef.current = operation;
      setBusy(operation);
      try {
        return await work(configuredClient());
      } catch (error) {
        return safeAuthFeedback(error, supabase ? context : 'configuration');
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [],
  );

  const processCallback = useCallback(async (url: string) => {
    const parsed = parseAuthCallbackUrl(url);
    if (!parsed || handledCallbacks.current.has(url)) return false;
    handledCallbacks.current.add(url);
    if (handledCallbacks.current.size > 12) {
      const oldest = handledCallbacks.current.values().next().value as string | undefined;
      if (oldest) handledCallbacks.current.delete(oldest);
    }

    const client = configuredClient();
    const result = await exchangeAuthCallback(client, url);
    if (result.recovery) setPasswordRecovery(true);
    return result.handled;
  }, []);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return undefined;
    }

    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      if (event === 'SIGNED_OUT') setPasswordRecovery(false);
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    }).catch(() => {
      if (!active) return;
      setSession(null);
      setReady(true);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || Platform.OS === 'web') return undefined;
    const client = supabase;
    if (AppState.currentState === 'active') client.auth.startAutoRefresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    });
    return () => {
      subscription.remove();
      client.auth.stopAutoRefresh();
    };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const handleUrl = (url: string) => {
      void processCallback(url).catch((error) => {
        if (active) setPendingFeedback(safeAuthFeedback(error, 'oauth'));
      });
    };

    void Linking.getInitialURL().then((url) => {
      if (url && active) handleUrl(url);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [processCallback]);

  useEffect(() => {
    if (!supabase) return undefined;
    return subscribeToAppleCredentialRevocation(() => {
      void supabase?.auth.signOut({ scope: 'local' });
    });
  }, []);

  const signInWithEmail = useCallback(
    (input: EmailAuthInput) =>
      runOperation('email', input.mode, async (client) => {
        if (input.mode === 'login') {
          const { error } = await client.auth.signInWithPassword({
            email: input.email.trim(),
            password: input.password,
          });
          if (error) throw error;
          return { kind: 'success', key: 'auth.welcomeGeneric' };
        }

        const { data, error } = await client.auth.signUp({
          email: input.email.trim(),
          password: input.password,
          options: {
            data: { full_name: input.name.trim().slice(0, 80) },
            emailRedirectTo: makeAuthEmailRedirectUri(),
          },
        });
        if (error) throw error;
        return data.session
          ? { kind: 'success', key: 'auth.accountCreated' }
          : { kind: 'success', key: 'auth.checkEmail' };
      }),
    [runOperation],
  );

  const signInWithGoogle = useCallback(
    () =>
      runOperation('google', 'oauth', async (client) => {
        const callbackUrl = await launchGoogleOAuth(client);
        if (!callbackUrl) return { kind: 'silent' };
        await processCallback(callbackUrl);
        return { kind: 'success', key: 'auth.welcomeGeneric' };
      }),
    [processCallback, runOperation],
  );

  const signInWithApple = useCallback(
    () =>
      runOperation('apple', 'oauth', async (client) => {
        await performNativeAppleSignIn(client);
        return { kind: 'success', key: 'auth.welcomeGeneric' };
      }),
    [runOperation],
  );

  const requestPasswordReset = useCallback(
    (email: string) =>
      runOperation('reset', 'reset', async (client) => {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: makeAuthEmailRedirectUri(AUTH_RESET_PATH),
        });
        if (error) throw error;
        return { kind: 'success', key: 'auth.passwordRecoveryNotice' };
      }),
    [runOperation],
  );

  const updatePassword = useCallback(
    (password: string) =>
      runOperation('update-password', 'update-password', async (client) => {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setPasswordRecovery(false);
        return { kind: 'success', key: 'auth.passwordUpdated' };
      }),
    [runOperation],
  );

  const signOut = useCallback(
    () =>
      runOperation('sign-out', 'sign-out', async (client) => {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw error;
        setPasswordRecovery(false);
        return { kind: 'success', key: 'auth.signedOut' };
      }),
    [runOperation],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      ready,
      configured: Boolean(supabase),
      busy,
      passwordRecovery,
      pendingFeedback,
      clearPendingFeedback: () => setPendingFeedback(null),
      signInWithEmail,
      signInWithGoogle,
      signInWithApple,
      requestPasswordReset,
      updatePassword,
      cancelPasswordRecovery: () => setPasswordRecovery(false),
      signOut,
    }),
    [
      busy,
      passwordRecovery,
      pendingFeedback,
      ready,
      requestPasswordReset,
      session,
      signInWithApple,
      signInWithEmail,
      signInWithGoogle,
      signOut,
      updatePassword,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
