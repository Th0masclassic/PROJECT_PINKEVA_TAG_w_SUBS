import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

const appleSignInEnabled = process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN === 'true';

export function AppleSignInButton({
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!appleSignInEnabled) return undefined;
    let active = true;
    void AppleAuthentication.isAvailableAsync().then((value) => {
      if (active) setAvailable(value);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!appleSignInEnabled || !available) return null;
  return (
    <View pointerEvents={disabled ? 'none' : 'auto'} style={disabled && styles.disabled}>
      <AppleAuthentication.AppleAuthenticationButton
        accessibilityLabel={accessibilityLabel}
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
        cornerRadius={14}
        onPress={onPress}
        style={styles.button}
        testID="auth-apple"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  button: { width: '100%', height: 56 },
  disabled: { opacity: 0.48 },
});
