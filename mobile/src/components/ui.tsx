import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { radius, space, useTheme } from '../theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }, style]}>{children}</View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.ink }]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.label, { color: t.soft }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.soft : t.ink }]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : 'transparent';
  const fg = kind === 'primary' ? t.onAccent : kind === 'danger' ? t.danger : t.ink;
  const border = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : t.line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: space.xs }}>
      <Label>{label}</Label>
      <TextInput
        placeholderTextColor={t.soft}
        {...rest}
        style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.bg }, style]}
      />
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: selected ? t.accent : t.line, backgroundColor: selected ? t.tint : 'transparent' },
      ]}
    >
      <Text style={{ color: t.ink, fontWeight: selected ? '700' : '500' }}>{label}</Text>
    </Pressable>
  );
}

export function Notice({ text, kind = 'info' }: { text: string; kind?: 'info' | 'error' | 'ok' }) {
  const t = useTheme();
  const color = kind === 'error' ? t.danger : kind === 'ok' ? t.ok : t.soft;
  return <Text style={[styles.notice, { color }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  body: { fontSize: 15, lineHeight: 22 },
  button: {
    minHeight: 48,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 16 },
  chip: { borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  notice: { fontSize: 14, lineHeight: 20 },
});
