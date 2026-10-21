import { passAcceptPatch, passRemovePatch, type PassQr } from './pass.js';

/** One on-device plate read, with the region it was read in and whether it matched a known plate format. */
export interface Candidate { text: string; norm: string; confidence: number; region?: string; formatValid: boolean | null }

/** The check-in flow's working state: the plate being entered, where it came from, and any scanned guest pass. */
export interface FlowState {
  plate: string; region: string; source: 'manual' | 'ai_assist' | 'ai_auto';
  candidates: Candidate[]; confidence?: number; textRaw?: string; cropKey?: string;
  /** True while `plate` was filled from a scanned pass hint, so it clears when the pass is removed or replaced. */
  plateFromPass: boolean;
  vehicle: { make?: string; model?: string; color?: string; bodyType?: string };
  /** A scanned resident guest pass: check-in is then free and tied to the pass. */
  pass: { token: string; guest: string; unit: string; plateHint?: string; verifyCode?: string } | null;
}

export const emptyFlow = (region: string): FlowState => ({ plate: '', region, source: 'manual', candidates: [], vehicle: {}, pass: null, plateFromPass: false });

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
    plate: patch.plate, plateFromPass: patch.plateFromPass,
    ...(patch.plate ? { region: a.regions[0] ?? s.region, source: 'manual' as const } : {}),
    ...(patch.clearRead ? clearedRead : {}),
  };
}

/** The state patch when the current pass is removed: drop a plate that came from it, keep one the attendant captured. */
export function applyPassRemove(s: FlowState): Partial<FlowState> {
  const patch = passRemovePatch({ plate: s.plate, plateFromPass: s.plateFromPass });
  return { pass: null, plate: patch.plate, plateFromPass: patch.plateFromPass, ...(patch.clearRead ? clearedRead : {}) };
}
