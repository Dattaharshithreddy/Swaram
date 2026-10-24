import { useColorScheme } from 'react-native';

/** Swaram palette: kumkum red and turmeric on a cool ink/paper base. */
const light = {
  bg: '#EEF0F4',
  surface: '#FFFFFF',
  ink: '#191A2E',
  soft: '#4D5068',
  line: '#D6D9E3',
  accent: '#C4213A',
  onAccent: '#FFFFFF',
  turmeric: '#F1B431',
  tint: '#F7E3E6',
  ok: '#2F7D5B',
  danger: '#B3261E',
};

const dark: typeof light = {
  bg: '#12131F',
  surface: '#1B1D2E',
  ink: '#ECEAF2',
  soft: '#A6A8BD',
  line: '#2D3047',
  accent: '#FF5A6E',
  onAccent: '#1A0207',
  turmeric: '#F5C351',
  tint: '#2A1B26',
  ok: '#6FD0A4',
  danger: '#FF8A80',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
