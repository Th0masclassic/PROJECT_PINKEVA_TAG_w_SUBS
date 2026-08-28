import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Field, PrimaryButton } from '../components';
import { colors, radii } from '../theme';

export function SignInScreen({
  configured,
  busy,
  message,
  onSubmit,
}: {
  configured: boolean;
  busy: boolean;
  message: string | null;
  onSubmit: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  const submit = () => {
    if (!email.trim() || password.length < 8) {
      setLocalMessage('Enter your authorized email and password.');
      return;
    }
    setLocalMessage(null);
    onSubmit(email.trim(), password);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.container}>
            <Brand admin />
            <View style={styles.tagline}>
              <Ionicons name="shield-checkmark" color={colors.blue} size={21} />
              <Text style={styles.taglineText}>Restricted operations</Text>
            </View>

            <View style={styles.form}>
              <View style={styles.intro}>
                <Text style={styles.title}>Welcome back</Text>
                <Text style={styles.body}>Sign in with an authorized Pinkeva owner or administrator account. MFA is required before data is shown.</Text>
              </View>
              <Field
                label="Email"
                icon="mail-outline"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="username"
                returnKeyType="next"
                editable={!busy}
              />
              <View>
                <Field
                  label="Password"
                  icon="lock-closed-outline"
                  value={password}
                  onChangeText={setPassword}
                  autoCapitalize="none"
                  autoComplete="current-password"
                  textContentType="password"
                  secureTextEntry={!visible}
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  editable={!busy}
                />
                <Pressable accessibilityRole="button" accessibilityLabel={visible ? 'Hide password' : 'Show password'} onPress={() => setVisible((current) => !current)} style={styles.eyeButton}>
                  <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} color={colors.mutedDark} size={23} />
                </Pressable>
              </View>
              {localMessage || message ? <Text accessibilityRole="alert" style={styles.error}>{localMessage ?? message}</Text> : null}
              {!configured ? <Text accessibilityRole="alert" style={styles.error}>This build is missing its public Supabase or API configuration.</Text> : null}
              <PrimaryButton label={busy ? 'Signing in…' : 'Continue securely'} icon="lock-closed" disabled={busy || !configured} onPress={submit} />
            </View>

            <View style={styles.securityNote}>
              <Ionicons name="phone-portrait-outline" color={colors.muted} size={20} />
              <Text style={styles.securityText}>This Admin app has its own encrypted session storage and is separate from the customer Pinkeva app.</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flexGrow: 1, justifyContent: 'center', paddingVertical: 28 },
  container: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24 },
  tagline: { marginTop: 7, marginBottom: 30, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  taglineText: { color: colors.mutedDark, fontSize: 16, fontWeight: '600' },
  form: { gap: 16 },
  intro: { gap: 7, marginBottom: 4 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -.5 },
  body: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  eyeButton: { position: 'absolute', right: 7, bottom: 6, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radii.pill },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  securityNote: { marginTop: 26, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: radii.medium, backgroundColor: colors.background },
  securityText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 19 },
});
