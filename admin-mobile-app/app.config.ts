import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidMapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  const plugins = [...(config.plugins ?? [])];

  if (androidMapsKey) {
    plugins.push([
      'react-native-maps',
      { androidGoogleMapsApiKey: androidMapsKey },
    ]);
  }

  return { ...config, plugins } as ExpoConfig;
};
