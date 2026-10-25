import { Text, View } from 'react-native';
import { romanToTelugu, hasLatin } from '../translit';
import { font, radius, space, useTheme } from '../theme';

/** Shows the Telugu-script version of English-letter typing, with a way to edit it. */
export function ReadAs({ text, language, onUse }: { text: string; language?: string; onUse: (s: string) => void }) {
  const t = useTheme();
  if (language !== 'te' || !hasLatin(text)) return null;
  const converted = romanToTelugu(text);
  return (
    <View style={{ borderRadius: radius.md, padding: space.md, gap: 6, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.line }}>
      <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 11, letterSpacing: 0.6 }}>WILL BE READ AS</Text>
      <Text selectable style={{ color: t.ink, fontSize: 18, lineHeight: 28 }}>
        {converted}
      </Text>
      <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }} onPress={() => onUse(converted)}>
        Edit in Telugu script
      </Text>
    </View>
  );
}
