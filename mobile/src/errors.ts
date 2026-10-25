/**
 * Turns technical errors into short, plain messages. Native errors arrive as
 * "Call to function 'X' has been rejected. → Caused by: …"; network failures
 * come in many shapes (no DNS, aborted connection, timeouts).
 */
const NETWORK = [
  /unable to resolve host/i,
  /unknownhost/i,
  /no address associated/i,
  /connection abort/i,
  /connection reset/i,
  /failed to connect/i,
  /network request failed/i,
  /network is unreachable/i,
  /software caused connection abort/i,
  /timeout|timed out/i,
  /socket/i,
  /enotfound|econn|eai_again/i,
  /fetch failed/i,
  /unable to download a file/i,
  /internet/i,
];

export function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return NETWORK.some((re) => re.test(msg));
}

export function friendlyError(e: unknown, context?: 'download' | 'kaggle' | 'server'): string {
  if (isNetworkError(e)) {
    if (context === 'download') return 'No internet connection. Connect to Wi-Fi or mobile data and tap Download again; finished files are kept.';
    if (context === 'kaggle') return 'No internet connection. Training status is checked again when you are back online.';
    return 'No internet connection. Connect to Wi-Fi or mobile data and try again.';
  }
  let msg = e instanceof Error ? e.message : String(e);
  // Keep only the useful part of native errors.
  const caused = /Caused by:\s*([\s\S]*)$/.exec(msg);
  if (caused) msg = caused[1];
  msg = msg.replace(/^Call to function '[^']+' has been rejected\.?\s*/i, '').replace(/^→\s*/, '').trim();
  if (/no space left|ENOSPC/i.test(msg)) return 'Your phone is out of storage. Free some space and try again.';
  if (/permission/i.test(msg) && /denied/i.test(msg)) return 'Permission was denied. Allow it in your phone settings and try again.';
  return msg || 'Something went wrong. Please try again.';
}
