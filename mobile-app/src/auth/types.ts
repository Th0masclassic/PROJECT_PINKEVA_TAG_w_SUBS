import type { Session, User } from '@supabase/supabase-js';

import type { TranslationKey, TranslationParams } from '../i18n';

export type AuthMode = 'login' | 'register';

export type AuthOperation =
  | 'email'
  | 'google'
  | 'apple'
  | 'reset'
  | 'update-password'
  | 'sign-out';

export type AuthFeedback = {
  kind: 'success' | 'error' | 'silent';
  key?: TranslationKey;
  params?: TranslationParams;
};

export type EmailAuthInput = {
  mode: AuthMode;
  name: string;
  email: string;
  password: string;
};

export type AuthContextValue = {
  session: Session | null;
  user: User | null;
  ready: boolean;
  configured: boolean;
  busy: AuthOperation | null;
  passwordRecovery: boolean;
  pendingFeedback: AuthFeedback | null;
  clearPendingFeedback: () => void;
  getAccessToken: () => Promise<string | null>;
  signInWithEmail: (input: EmailAuthInput) => Promise<AuthFeedback>;
  signInWithGoogle: () => Promise<AuthFeedback>;
  signInWithApple: () => Promise<AuthFeedback>;
  requestPasswordReset: (email: string) => Promise<AuthFeedback>;
  updatePassword: (password: string) => Promise<AuthFeedback>;
  cancelPasswordRecovery: () => void;
  signOut: () => Promise<AuthFeedback>;
};
