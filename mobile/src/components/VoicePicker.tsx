import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { keyOf, type VoiceRef } from '../edge/voices';
import { font, radius, space, useTheme } from '../theme';
import { Badge, Icon } from './ui';

/** Bottom sheet to choose a voice. */
export function VoicePicker({
  visible,
  title,
  voices,
  selectedKey,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  voices: VoiceRef[];
  selectedKey?: string;
  onPick: (v: VoiceRef) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} />
      <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: space.lg, gap: space.md, maxHeight: '70%' }}>
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.lineStrong }} />
        <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 17 }}>{title}</Text>
        <ScrollView contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}>
          {voices.length === 0 && <Text style={{ color: t.soft, fontFamily: font.regular }}>No voices yet. Make one in the Voices tab.</Text>}
          {voices.map((v) => {
            const on = keyOf(v) === selectedKey;
            return (
              <Pressable
                key={keyOf(v)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  onPick(v);
                  onClose();
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.tint : t.bg }}
              >
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: v.kind === 'fast' ? t.goldBg : t.surface2, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: v.kind === 'fast' ? t.goldText : t.ink, fontFamily: font.heavy, fontSize: 15 }}>{v.voice.name.slice(0, 2).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 15 }}>{v.voice.name}</Text>
                  {v.kind === 'fast' ? <Badge text="Fast voice" kind="gold" icon="zap" /> : <Badge text="Big model" />}
                </View>
                {on && <Icon name="check" color={t.accent} />}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}
