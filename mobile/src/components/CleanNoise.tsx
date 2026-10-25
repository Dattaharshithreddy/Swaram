import { File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { SwaramEdge } from '../../modules/swaram-edge';
import { readFloats, writeFloats } from '../edge/engine';
import { Button, Notice } from './ui';
import { friendlyError } from '../errors';

/** "Clean up noise" for a recording (fans, traffic, hiss), with undo. */
export function CleanNoise({ clip, onClip }: { clip: Float32Array | null; onClip: (c: Float32Array) => void }) {
  const original = useRef<Float32Array | null>(null);
  const [cleaned, setCleaned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new recording resets the state.
  useEffect(() => {
    if (clip && original.current !== clip && !busy && !cleaned) original.current = clip;
    if (!clip) {
      original.current = null;
      setCleaned(false);
    }
  }, [clip, busy, cleaned]);

  if (!clip) return null;

  async function clean() {
    if (!clip || !SwaramEdge) return;
    setBusy(true);
    setError(null);
    try {
      original.current = clip;
      const src = new File(Paths.cache, 'swaram-clean-in.f32');
      const out = new File(Paths.cache, 'swaram-clean-out.f32');
      for (const f of [src, out]) if (f.exists) f.delete();
      writeFloats(src, clip);
      await SwaramEdge.denoise(src.uri, out.uri, 0.6);
      const next = await readFloats(out);
      setCleaned(true);
      onClip(next);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {cleaned ? (
        <Button
          title="Undo noise cleanup"
          icon="rotate-ccw"
          kind="secondary"
          small
          onPress={() => {
            if (original.current) onClip(original.current);
            setCleaned(false);
          }}
        />
      ) : (
        <Button title="Clean up background noise" icon="wind" kind="secondary" small busy={busy} onPress={clean} />
      )}
      {cleaned && <Notice text="Background noise reduced. Play it to check; undo if the voice sounds thin." kind="ok" />}
      {error && <Notice text={error} kind="error" />}
    </>
  );
}
