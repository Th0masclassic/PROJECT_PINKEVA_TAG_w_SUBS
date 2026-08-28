import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Field, PrimaryButton, SecondaryButton } from '../components';
import { colors, radii } from '../theme';

export function MfaScreen({
  factorReady,
  secret,
  uri,
  busy,
  message,
  onVerify,
  onSignOut,
}: {
  factorReady: boolean;
  secret: string | null;
  uri: string | null;
  busy: boolean;
  message: string;
  onVerify: (code: string) => void;
  onSignOut: () => void;
}) {
  const [code, setCode] = useState('');
  const canVerify = factorReady && /^\d{6}$/.test(code) && !busy;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.container}>
            <Brand admin />
            <View style={styles.shield}><Ionicons name="shield-checkmark" color="#FFFFFF" size={36} /></View>
            <Text style={styles.eyebrow}>MULTI-FACTOR AUTHENTICATION</Text>
            <Text style={styles.title}>Verify it’s you</Text>
            <Text style={styles.body}>{message}</Text>

            {secret ? (
              <View style={styles.setupCard}>
                <Text style={styles.setupTitle}>Authenticator setup key</Text>
                <Text selectable style={styles.secret}>{secret}</Text>
                <View style={styles.buttonStack}>
                  {uri ? <SecondaryButton label="Open authenticator" icon="open-outline" onPress={() => void Linking.openURL(uri)} /> : null}
                  <SecondaryButton label="Copy setup key" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(secret)} />
                </View>
                <Text style={styles.setupNote}>Add the key to your authenticator app, then return here with the current six-digit code.</Text>
              </View>
            ) : null}

            <View style={styles.form}>
              <Field
                label="Authentication code"
                icon="keypad-outline"
                value={code}
                onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                editable={!busy && factorReady}
                placeholder="000000"
                onSubmitEditing={() => canVerify && onVerify(code)}
              />
              <PrimaryButton label={busy ? 'Verifying…' : 'Verify and open Admin'} icon="shield-checkmark" disabled={!canVerify} onPress={() => onVerify(code)} />
              <SecondaryButton label="Sign out" onPress={onSignOut} />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', paddingVertical: 28 },
  container: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24, alignItems: 'center' },
  shield: { width: 68, height: 68, marginTop: 24, marginBottom: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: colors.blue },
  eyebrow: { color: colors.blue, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  title: { marginTop: 7, color: colors.text, fontSize: 31, fontWeight: '800' },
  body: { marginTop: 8, maxWidth: 420, color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  setupCard: { width: '100%', marginTop: 20, padding: 18, borderWidth: 1, borderColor: colors.border, borderRadius: radii.medium, backgroundColor: colors.surface },
  setupTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  secret: { marginVertical: 12, padding: 12, borderRadius: radii.small, color: colors.navy, backgroundColor: colors.bluePale, fontSize: 16, fontWeight: '700', letterSpacing: 1.2, textAlign: 'center' },
  buttonStack: { gap: 9 },
  setupNote: { marginTop: 13, color: colors.muted, fontSize: 12, lineHeight: 18 },
  form: { width: '100%', marginTop: 22, gap: 13 },
});
