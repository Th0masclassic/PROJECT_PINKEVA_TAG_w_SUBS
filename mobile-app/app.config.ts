import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY?.trim();
  const androidKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  const plugins = [...(config.plugins ?? [])];

  if (iosKey || androidKey) {
    plugins.push([
      'react-native-maps',
      {
        ...(iosKey ? { iosGoogleMapsApiKey: iosKey } : {}),
        ...(androidKey ? { androidGoogleMapsApiKey: androidKey } : {}),
      },
    ]);
  }

  return {
    ...config,
    plugins,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSLocationWhenInUseUsageDescription:
          'Pinkeva uses your location only when you choose to center the map around your tags.',
      },
    },
  } as ExpoConfig;
};
