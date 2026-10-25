/**
 * Swaram's studio palette: deep indigo, lavender accent, gold for ⚡ fast voices.
 * One dark theme on purpose (an audio studio, and it keeps contrast checked
 * in one place). Token names stay stable across the app.
 */
const studio = {
  bg: '#100E24',
  surface: '#1C1844',
  surface2: '#262158',
  field: '#120F2C',
  ink: '#F1EFFF',
  soft: '#B4AEDB',
  faint: '#8E88BF',
  line: '#2E2866',
  lineStrong: '#3B3485',
  accent: '#A99CF5',
  onAccent: '#14102E',
  tint: '#2A2462',
  gold: '#F5B544',
  goldText: '#F7C86E',
  goldBg: '#2E2615',
  ok: '#7EE2A8',
  okBg: '#14302A',
  danger: '#FF9AA0',
  dangerLine: '#5A2F45',
  turmeric: '#F5C351',
  tab: '#141130',
  chipText: '#D2CDF2',
};

export type Theme = typeof studio;

export function useTheme(): Theme {
  return studio;
}

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

/** Font families loaded in App.tsx (Plus Jakarta Sans); Telugu falls back to the system's Noto Sans Telugu. */
export const font = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  heavy: 'PlusJakartaSans_800ExtraBold',
};

/** Speaker colours for multi-voice scripts (distinct in lightness as well as hue). */
export const speakerColors = ['#F5C46B', '#8FC7FF', '#F0A6D8', '#7EE2A8', '#C3A6FF', '#FFB38A'];
