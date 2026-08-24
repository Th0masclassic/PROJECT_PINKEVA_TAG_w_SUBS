import { Platform } from 'react-native';

export const colors = {
  background: '#F7F9FD',
  surface: '#FFFFFF',
  navy: '#06163A',
  navySoft: '#142957',
  blue: '#0757FF',
  blueDark: '#0539B8',
  bluePale: '#EAF1FF',
  text: '#071535',
  muted: '#65708C',
  mutedDark: '#46516D',
  border: '#E6EAF2',
  danger: '#F21E24',
  success: '#0E5BFF',
  mapWater: '#B9E1F8',
  mapLand: '#F7FAF7',
  shadow: '#132856',
};

export const radii = {
  small: 12,
  medium: 18,
  large: 26,
  pill: 999,
};

export const shadow = Platform.select({
  ios: {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
  },
  android: {
    elevation: 4,
  },
  default: {
    boxShadow: '0px 8px 24px rgba(19, 40, 86, 0.10)',
  },
});

export const typography = {
  hero: 42,
  pageTitle: 36,
  title: 28,
  heading: 22,
  body: 16,
  small: 14,
};
