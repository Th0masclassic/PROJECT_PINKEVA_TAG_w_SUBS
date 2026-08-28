import { Platform, type ViewStyle } from 'react-native';

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
  danger: '#D72532',
  dangerPale: '#FFF0F1',
  success: '#0A8059',
  successPale: '#E4F7EF',
  shadow: '#132856',
};

export const radii = { small: 12, medium: 18, large: 26, pill: 999 };

export const shadow: ViewStyle = Platform.OS === 'ios'
  ? {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.09,
    shadowRadius: 18,
  }
  : Platform.OS === 'android'
    ? { elevation: 4 }
    : {};
