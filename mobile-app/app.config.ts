import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY?.trim();
  const androidKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  const plugins = [...(config.plugins ?? [])];
  const locationPermission =
    'Pinkeva uses your location to center the map on the nearest tag.';

  plugins.push([
    'expo-location',
    { locationWhenInUsePermission: locationPermission },
  ]);

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
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
        ],
        NSPrivacyCollectedDataTypes: [],
        NSPrivacyTracking: false,
      },
      infoPlist: {
        ...config.ios?.infoPlist,
        NSLocationWhenInUseUsageDescription: locationPermission,
      },
    },
  } as ExpoConfig;
};
