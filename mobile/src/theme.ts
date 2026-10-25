/**
 * Swaram's studio palette: deep ink, coral accent, gold for ⚡ fast voices.
 * One dark theme on purpose (an audio studio, and it keeps contrast checked
 * in one place). Token names stay stable across the app.
 */
const studio = {
  bg: '#0E0F1A',
  surface: '#171929',
  surface2: '#1F2236',
  field: '#0E0F1A',
  ink: '#F2F2F7',
  soft: '#A3A7C2',
  faint: '#8C90AB',
  line: '#262A40',
  lineStrong: '#2E3350',
  accent: '#F2737B',
  onAccent: '#1B0A0C',
  tint: '#2A1A1E',
  gold: '#F5B544',
  goldText: '#F5C46B',
  goldBg: '#2A2213',
  ok: '#7EE2A8',
  okBg: '#13261E',
  danger: '#FF9AA0',
  dangerLine: '#4A2A30',
  turmeric: '#F5C351',
  tab: '#12131F',
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
