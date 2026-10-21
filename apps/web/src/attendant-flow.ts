import { passAcceptPatch, passRemovePatch, type PassQr } from './pass.js';

/** One on-device plate read, with the region it was read in and whether it matched a known plate format. */
export interface Candidate { text: string; norm: string; confidence: number; region?: string; formatValid: boolean | null }

/** The check-in flow's working state: the plate being entered, where it came from, and any scanned guest pass. */
export interface FlowState {
  plate: string; region: string; source: 'manual' | 'ai_assist' | 'ai_auto';
  candidates: Candidate[]; confidence?: number; textRaw?: string; cropKey?: string;
  /** True while `plate` was filled from a scanned pass hint, so it clears when the pass is removed or replaced. */
  plateFromPass: boolean;
  /**
   * True while a scanned/typed pass is being verified by the server. Confirm stays disabled until it settles, so the
   * attendant can never submit the ordinary walk-in branch (leaving a valid pass unredeemed) mid-lookup.
   */
  passPending: boolean;
  /**
   * A rejected scan's message, PERSISTED on the flow (not in a screen that unmounts). A live camera plate read can
   * navigate away from the capture screen while the lookup is still in flight; if the lookup then rejects, the message
   * must survive so it is shown on Review/Confirm. While it is set, Confirm stays disabled, so the attendant cannot
   * silently submit an ordinary walk-in that hides a failed pass — they must explicitly acknowledge the rejection first.
   */
  passError: string | null;
  vehicle: { make?: string; model?: string; color?: string; bodyType?: string; year?: number };
  /** A scanned resident guest pass: check-in is then free and tied to the pass. */
  pass: { token: string; guest: string; unit: string; plateHint?: string; verifyCode?: string } | null;
}

export const emptyFlow = (region: string): FlowState => ({ plate: '', region, source: 'manual', candidates: [], vehicle: {}, pass: null, plateFromPass: false, passPending: false, passError: null });

/** The patch that marks a pass lookup as in flight. Apply it the instant a QR/code is accepted, before the round trip; it also clears any prior rejection, since a new scan supersedes it. */
export const beginPassLookup = (): Partial<FlowState> => ({ passPending: true, passError: null });

/**
 * The patch when a pass lookup fails or is rejected: clear the pending flag and PERSIST the reason on the flow, so a
 * rejection that lands after the camera already navigated away is still shown and still blocks confirm. No pass is
 * attached. The attendant must acknowledge (see {@link clearPassError}) before an ordinary walk-in can be submitted.
 */
export const applyPassError = (message: string): Partial<FlowState> => ({ passPending: false, passError: message });

/** The patch when the attendant explicitly acknowledges a rejected scan: clear the message so a walk-in may proceed. */
export const clearPassError = (): Partial<FlowState> => ({ passError: null });

/**
 * Is a resolved pass lookup stale? Each lookup is tagged with the sequence it was issued at; if a newer scan has since
 * been issued (`latestSeq` moved on), the older response that resolved last must be ignored so the newest scan wins.
 */
export const isStalePassLookup = (mySeq: number, latestSeq: number): boolean => mySeq !== latestSeq;

/**
 * Whether the attendant may submit check-in: a plate is present, nothing else is in flight, no pass lookup is pending,
 * and no rejected scan is awaiting acknowledgment (an unacknowledged rejection must not be hidden behind a walk-in).
 */
export const canConfirm = (s: FlowState, busy: boolean): boolean => !busy && !!s.plate && !s.passPending && !s.passError;

/** A walk-in host value: a chosen community unit, or an "Other" authorizer's name + E.164 phone. Null until complete. */
export type HostValue = { unit: string } | { name: string; phone: string } | null;

/**
 * Is the host attribution complete enough to submit a WALK-IN check-in (AC-4.2.4.3/4)? A pass redemption fixes the
 * host to the pass's unit and needs no walk-in host, so it is always valid. Otherwise a unit must be chosen, or a
 * complete "Other" authorizer given: a non-empty name AND an E.164 phone. A half-filled "Other" is not valid.
 */
export function hostValid(host: HostValue, hasPass: boolean): boolean {
  if (hasPass) return true;
  if (!host) return false;
  if ('unit' in host) return !!host.unit;
  return !!host.name.trim() && /^\+[1-9]\d{7,14}$/.test(host.phone.trim());
}

/** Clear read metadata alongside a pass-derived plate, so a stale candidate/confidence never rides on the next pass. */
const clearedRead = { candidates: [] as Candidate[], confidence: undefined, textRaw: undefined, cropKey: undefined };

/** A looked-up pass ready to apply: its token, guest/unit, the parsed QR (for the plate hint and verify code), and the tenant's plate regions. */
export interface PassAccept { token: string; guest: string; unit: string; q: PassQr | null; regions: string[] }

/**
 * The state patch when a looked-up pass is accepted, computed against the LATEST flow state `s` (apply it with a
 * functional update, never a render-time snapshot). A hinted pass fills the plate (provenance = pass); a no-hint pass
 * clears a plate left over from a PREVIOUS pass but KEEPS a plate the attendant captured independently — so a camera
 * read that lands before a slow no-hint lookup is never erased by that lookup.
 */
export function applyPassAccept(s: FlowState, a: PassAccept): Partial<FlowState> {
  const patch = passAcceptPatch({ plate: s.plate, plateFromPass: s.plateFromPass }, a.q);
  return {
    pass: { token: a.token, guest: a.guest, unit: a.unit, plateHint: a.q?.plate || undefined, verifyCode: a.q?.code },
    plate: patch.plate, plateFromPass: patch.plateFromPass, passPending: false, passError: null,
    ...(patch.plate ? { region: a.regions[0] ?? s.region, source: 'manual' as const } : {}),
    ...(patch.clearRead ? clearedRead : {}),
  };
}

/**
 * Segment layout for the capacity bar from the live occupancy counts. `n` is the bar length, already computed as
 * totals.free + totals.occupied + totals.reserved (every assignable slot). Passes are NOT slot reservations, so
 * yellow is a visual continuation after green, never an overlap:
 *  - green  = checked-in vehicles, capped at n
 *  - yellow = logged-but-not-checked-in passes that still fit after green
 *  - free   = the light-gray remainder
 *  - pendingSurplus = pending passes with no segment left (shown only in the caption, never drawn)
 *  - over10/over12 = currently-parked cars past the thresholds (subsets of occupied), drawn as overlays on the
 *    rightmost green segments (RED over ORANGE), never as extra length — passed through unchanged.
 */
export function capacityBar(input: { n: number; occupied: number; issuedPending: number; over10: number; over12: number }):
  { green: number; yellow: number; free: number; pendingSurplus: number; over10: number; over12: number } {
  const n = Math.max(0, input.n);
  const green = Math.min(input.occupied, n);
  const yellow = Math.max(0, Math.min(n - green, input.issuedPending));
  const free = n - green - yellow;
  const pendingSurplus = Math.max(0, input.issuedPending - (n - green));
  return { green, yellow, free, pendingSurplus, over10: input.over10, over12: input.over12 };
}

/** The state patch when the current pass is removed: drop a plate that came from it, keep one the attendant captured. */
export function applyPassRemove(s: FlowState): Partial<FlowState> {
  const patch = passRemovePatch({ plate: s.plate, plateFromPass: s.plateFromPass });
  return { pass: null, passPending: false, passError: null, plate: patch.plate, plateFromPass: patch.plateFromPass, ...(patch.clearRead ? clearedRead : {}) };
}
