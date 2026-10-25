import { SwaramEdge } from '../../modules/swaram-edge';

/** A pause that also works in the background (React Native pauses JS timers when the app is hidden). */
export function wait(ms: number): Promise<void> {
  return SwaramEdge ? SwaramEdge.sleep(ms) : new Promise((r) => setTimeout(r, ms));
}
