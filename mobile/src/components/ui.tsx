import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { font, radius, space, useTheme } from '../theme';

export type IconName = ComponentProps<typeof Feather>['name'];

export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const t = useTheme();
  return <Feather name={name} size={size} color={color ?? t.ink} />;
}

/** Scrolling page with the standard gutters. */
export function Screen({ children, refresh }: { children: ReactNode; refresh?: ReactNode }) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: space.lg, paddingTop: space.lg, gap: space.lg, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refresh as never}
    >
      {children}
    </ScrollView>
  );
}

export function Header({ title, subtitle, right, onBack }: { title: string; subtitle?: string; right?: ReactNode; onBack?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm }}>
      {onBack && <IconButton icon="chevron-left" label="Back" onPress={onBack} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.ink, fontFamily: font.heavy, fontSize: onBack ? 22 : 26, letterSpacing: -0.5 }}>{title}</Text>
        {subtitle ? <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 13 }}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.ink, fontFamily: font.heavy, fontSize: 22, letterSpacing: -0.3 }}>{children}</Text>;
}

/** Card heading (16 px bold) with an optional right-side element. */
export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
      <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 16, flexShrink: 1 }}>{children}</Text>
      {right}
    </View>
  );
}

/** Small caps section label. */
export function Label({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' }}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: TextStyle }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.soft : t.ink, fontFamily: font.regular, fontSize: 14, lineHeight: 21 }, style]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  busy,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'gold' | 'ghost';
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
  small?: boolean;
}) {
  const t = useTheme();
  const look = {
    primary: { bg: t.accent, fg: t.onAccent, border: t.accent },
    secondary: { bg: 'transparent', fg: t.ink, border: t.lineStrong },
    danger: { bg: 'transparent', fg: t.danger, border: t.dangerLine },
    gold: { bg: t.goldBg, fg: t.goldText, border: t.gold },
    ghost: { bg: 'transparent', fg: t.accent, border: 'transparent' },
  }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: look.bg, borderColor: look.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={look.fg} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon && <Feather name={icon} size={small ? 15 : 17} color={look.fg} />}
          <Text style={{ color: look.fg, fontFamily: kind === 'primary' ? font.heavy : font.bold, fontSize: small ? 13 : 15 }}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress, filled, color }: { icon: IconName; label: string; onPress: () => void; filled?: boolean; color?: string }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: filled ? t.surface2 : 'transparent', borderColor: filled ? t.surface2 : t.line, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Feather name={icon} size={17} color={color ?? t.ink} />
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string; hint?: string }) {
  const t = useTheme();
  const { label, hint, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        placeholderTextColor={t.faint}
        accessibilityLabel={label}
        {...rest}
        style={[styles.input, { color: t.ink, borderColor: t.lineStrong, backgroundColor: t.field }, style]}
      />
      {hint ? <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  gold,
  dot,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  gold?: boolean;
  dot?: string;
}) {
  const t = useTheme();
  const border = selected ? (gold ? t.gold : t.accent) : t.line;
  const bg = selected ? (gold ? t.goldBg : t.tint) : 'transparent';
  const fg = selected && gold ? t.goldText : selected ? t.ink : t.chipText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, { borderColor: border, backgroundColor: bg, borderWidth: selected ? 1.5 : 1 }]}
    >
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} /> : null}
      {gold ? <Feather name="zap" size={12} color={t.gold} /> : null}
      <Text style={{ color: fg, fontFamily: selected ? font.bold : font.semibold, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: radius.md, padding: 4 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            style={{ flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.line : 'transparent' }}
          >
            <Text style={{ color: on ? t.ink : t.soft, fontFamily: on ? font.bold : font.semibold, fontSize: 13 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ text, kind = 'plain', icon }: { text: string; kind?: 'plain' | 'gold' | 'ok' | 'danger'; icon?: IconName }) {
  const t = useTheme();
  const look = {
    plain: { bg: t.surface2, fg: t.chipText },
    gold: { bg: t.goldBg, fg: t.goldText },
    ok: { bg: t.okBg, fg: t.ok },
    danger: { bg: t.tint, fg: t.danger },
  }[kind];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 9, borderRadius: 12, backgroundColor: look.bg, alignSelf: 'flex-start' }}>
      {icon && <Feather name={icon} size={11} color={look.fg} />}
      <Text style={{ color: look.fg, fontFamily: font.bold, fontSize: 11 }}>{text}</Text>
    </View>
  );
}

export function ProgressBar({ value, color, height = 6 }: { value: number; color?: string; height?: number }) {
  const t = useTheme();
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: t.line, overflow: 'hidden' }}>
      <View style={{ height, width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: color ?? t.accent }} />
    </View>
  );
}

/** A settings-style row inside a Card. */
export function Row({ title, detail, right, onPress, last, detailKind }: { title: string; detail?: string; right?: ReactNode; onPress?: () => void; last?: boolean; detailKind?: 'ok' | 'danger' }) {
  const t = useTheme();
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.surface2 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>{title}</Text>
        {detail ? (
          <Text style={{ color: detailKind === 'ok' ? t.ok : detailKind === 'danger' ? t.danger : t.soft, fontFamily: font.regular, fontSize: 12 }}>{detail}</Text>
        ) : null}
      </View>
      {right ?? (onPress ? <Feather name="chevron-right" size={18} color={t.faint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function Notice({ text, kind = 'info' }: { text: string; kind?: 'info' | 'error' | 'ok' }) {
  const t = useTheme();
  const color = kind === 'error' ? t.danger : kind === 'ok' ? t.ok : t.soft;
  return <Text style={{ color, fontFamily: font.regular, fontSize: 13, lineHeight: 19 }}>{text}</Text>;
}

export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.lg }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name={icon} size={24} color={t.soft} />
      </View>
      <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 16, textAlign: 'center' }}>{title}</Text>
      <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{text}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  button: { minHeight: 50, borderRadius: radius.pill, borderWidth: 1.5, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { minHeight: 40, paddingHorizontal: space.md, borderWidth: 1 },
  iconButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  chip: { minHeight: 38, paddingHorizontal: 14, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: 6 },
});
