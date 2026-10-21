/** Fee-line codes from the fee engine ("first_period 60min", "increments x3") as text in the current language. */
export function feeLabel(t: (k: string, v?: Record<string, unknown>) => string, label: string): string {
  const m = /^([a-z_]+?)(?: x(\d+)| (\d+)min)?$/.exec(label);
  if (!m) return label;
  const key = `fee.${m[1]}`;
  const out = t(key, { n: Number(m[2] ?? 0), min: Number(m[3] ?? 0) });
  return out === key ? label : out;
}

/** Session timeline event types as text, falling back to the raw code for types added later. */
export function eventLabel(t: (k: string) => string, type: string): string {
  const key = `ev.${type}`;
  const out = t(key);
  return out === key ? type : out;
}

/** Why a guest pass was refused, in the current language; unknown codes fall back to the server's text. */
export function passReason(t: (k: string) => string, code: string, fallback = ''): string {
  const key = `pass.reason_${code}`;
  const out = t(key);
  return out === key ? (fallback || code) : out;
}
