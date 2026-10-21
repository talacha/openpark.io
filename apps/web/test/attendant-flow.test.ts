import { describe, expect, it } from 'vitest';
import { applyPassAccept, applyPassError, applyPassRemove, beginPassLookup, canConfirm, emptyFlow, isStalePassLookup, type FlowState, type PassAccept } from '../src/attendant-flow.js';
import { parsePassQr } from '../src/pass.js';

// A hinted pass (plate ABC123) and the same pass with no plate hint.
const qr = 'OPP2|PyuMHp1KTH6KVQtvbx0skA|3|K7Q2M9XA|DEMO-01|A-101|Rosa%20Gu%C3%A9sped|ABC123|1792540800|AbCdEfGhIjKlMnOpQrStUv';
const hinted = parsePassQr(qr)!;
const noHint = parsePassQr(qr.replace('ABC123', ''))!;

// Apply a patch the way the FlowCtx functional updater does: always against the LATEST state.
const apply = (s: FlowState, patch: Partial<FlowState>): FlowState => ({ ...s, ...patch });

describe('check-in flow transitions survive a camera/lookup race', () => {
  it('a no-hint pass lookup that resolves AFTER a camera plate read does not erase the read plate', () => {
    // onPlate wins first: the live camera reads a plate and fills the flow before the pass lookup returns.
    let s = apply(emptyFlow('MX'), { plate: 'XYZ999', plateFromPass: false, source: 'ai_auto', confidence: 0.97, textRaw: 'XYZ999' });
    // The deferred no-hint lookup now resolves and is applied against the LATEST state (not the pre-read snapshot).
    s = apply(s, applyPassAccept(s, { token: 'tok', guest: 'Rosa', unit: 'A-101', q: noHint, regions: ['MX'] }));
    expect(s.plate).toBe('XYZ999'); // the independently captured plate is preserved, not overwritten with ''
    expect(s.plateFromPass).toBe(false);
    expect(s.pass).toMatchObject({ token: 'tok', guest: 'Rosa', unit: 'A-101' });
  });

  it('a no-hint pass clears a plate left over from a PREVIOUS pass', () => {
    let s = apply(emptyFlow('MX'), { plate: 'ABC123', plateFromPass: true });
    s = apply(s, applyPassAccept(s, { token: 't2', guest: 'Leo', unit: 'B-2', q: noHint, regions: ['MX'] }));
    expect(s.plate).toBe('');
    expect(s.plateFromPass).toBe(false);
  });

  it('a hinted pass fills the plate and marks it pass-derived, even applied after a read', () => {
    let s = apply(emptyFlow('MX'), { plate: 'OLD111', plateFromPass: false });
    s = apply(s, applyPassAccept(s, { token: 't3', guest: 'g', unit: 'u', q: hinted, regions: ['MX'] }));
    expect(s.plate).toBe('ABC123');
    expect(s.plateFromPass).toBe(true);
    expect(s.region).toBe('MX');
    expect(s.source).toBe('manual');
  });

  it('removing a pass drops a pass-derived plate but keeps one the attendant captured', () => {
    let a = apply(emptyFlow('MX'), { plate: 'ABC123', plateFromPass: true, pass: { token: 't', guest: 'g', unit: 'u' } });
    a = apply(a, applyPassRemove(a));
    expect(a.plate).toBe('');
    expect(a.pass).toBeNull();

    let b = apply(emptyFlow('MX'), { plate: 'XYZ999', plateFromPass: false, pass: { token: 't', guest: 'g', unit: 'u' } });
    b = apply(b, applyPassRemove(b));
    expect(b.plate).toBe('XYZ999');
    expect(b.pass).toBeNull();
  });
});

/**
 * A faithful model of how `usePass()` in Attendant.tsx drives a lookup: it bumps a sequence, marks the flow pending,
 * and when the response lands applies it against the LATEST state ONLY if its sequence is still the latest. This
 * exercises the exact pure helpers (`beginPassLookup`, `isStalePassLookup`, `applyPassAccept`, `applyPassError`,
 * `canConfirm`) the component uses, so the camera/lookup race is regression-locked without a browser.
 */
function lookupHarness() {
  let s: FlowState = emptyFlow('MX');
  let latestSeq = 0;
  return {
    get state() { return s; },
    patch(p: Partial<FlowState>) { s = { ...s, ...p }; },
    /** Start a lookup; returns its sequence tag, mirroring `const mySeq = ++passSeq.current`. */
    begin() { latestSeq += 1; s = { ...s, ...beginPassLookup() }; return latestSeq; },
    /** A lookup resolves valid: ignored if a newer scan has since started. */
    resolveValid(mySeq: number, accept: PassAccept) {
      if (isStalePassLookup(mySeq, latestSeq)) return false;
      s = { ...s, ...applyPassAccept(s, accept) };
      return true;
    },
    /** A lookup resolves invalid/failed: ignored if stale, else clears pending with no pass attached. */
    resolveInvalid(mySeq: number) {
      if (isStalePassLookup(mySeq, latestSeq)) return false;
      s = { ...s, ...applyPassError() };
      return true;
    },
    /**
     * A scan rejected locally (e.g. a wrong-site QR) still claims the latest generation BEFORE the early return, then
     * clears pending — mirroring `const mySeq = ++passSeq.current` running ahead of the wrong-site branch in usePass.
     * This is what lets a newer wrong-site scan supersede an older in-flight lookup.
     */
    beginWrongSite() { latestSeq += 1; s = { ...s, ...applyPassError() }; return latestSeq; },
  };
}

describe('a pass lookup is a sequenced pending operation', () => {
  it('blocks confirmation until the lookup settles, then only the pass path is possible', () => {
    const h = lookupHarness();
    // A QR is scanned: the lookup goes pending.
    const seq = h.begin();
    expect(h.state.passPending).toBe(true);
    // Meanwhile the live camera reads the plate and navigates to confirm — but Confirm must stay disabled while pending,
    // so the attendant cannot submit the ordinary /v1/sessions (walk-in) branch and strand a valid pass.
    h.patch({ plate: 'XYZ999', plateFromPass: false, source: 'ai_auto' });
    expect(canConfirm(h.state, false)).toBe(false); // pending blocks confirm even though a plate is present
    // The lookup now resolves valid: the pass attaches and pending clears, so redemption (the pass path) is possible.
    expect(h.resolveValid(seq, { token: 'tok', guest: 'Rosa', unit: 'A-101', q: noHint, regions: ['MX'] })).toBe(true);
    expect(h.state.pass).toMatchObject({ token: 'tok' });
    expect(h.state.plate).toBe('XYZ999'); // the camera plate is preserved for the redeem
    expect(canConfirm(h.state, false)).toBe(true);
  });

  it('an invalid lookup clears pending and leaves no pass, so a walk-in can proceed', () => {
    const h = lookupHarness();
    const seq = h.begin();
    h.patch({ plate: 'WALK01', plateFromPass: false });
    expect(canConfirm(h.state, false)).toBe(false);
    expect(h.resolveInvalid(seq)).toBe(true);
    expect(h.state.pass).toBeNull();
    expect(h.state.passPending).toBe(false);
    expect(canConfirm(h.state, false)).toBe(true); // the plate stands as an ordinary paid stay
  });

  it('when two QR lookups resolve out of order, the newest scan wins', () => {
    const h = lookupHarness();
    const first = h.begin(); // scan A
    const second = h.begin(); // scan B supersedes A before either resolves
    // A resolves last (out of order) and must be ignored.
    expect(h.resolveValid(second, { token: 'B', guest: 'Beto', unit: 'B-2', q: noHint, regions: ['MX'] })).toBe(true);
    expect(h.resolveValid(first, { token: 'A', guest: 'Ana', unit: 'A-1', q: noHint, regions: ['MX'] })).toBe(false);
    expect(h.state.pass).toMatchObject({ token: 'B' });
    expect(h.state.passPending).toBe(false);
  });

  it('survives a confirm → edit remount: the generation does not reset, so an older lookup cannot overwrite a newer pass', () => {
    // The generation counter lives on the persistent Flow, so remounting CheckInCapture (capture → confirm → edit)
    // does NOT reset it. We model that by NOT recreating the harness between scans A and B.
    const h = lookupHarness();
    const first = h.begin(); // scan A on the first capture mount
    // ...the attendant navigates to Confirm, then "Back to edit" remounts the capture. The counter is untouched.
    const second = h.begin(); // scan B on the remounted capture — still increments the SAME shared counter
    // B resolves first and attaches; then the stale A resolves and is rejected, so B stays attached.
    expect(h.resolveValid(second, { token: 'B', guest: 'Beto', unit: 'B-2', q: noHint, regions: ['MX'] })).toBe(true);
    expect(h.resolveValid(first, { token: 'A', guest: 'Ana', unit: 'A-1', q: noHint, regions: ['MX'] })).toBe(false);
    expect(h.state.pass).toMatchObject({ token: 'B' });
  });

  it('a newer wrong-site scan invalidates an older in-flight lookup', () => {
    const h = lookupHarness();
    const first = h.begin(); // scan A (valid site) goes pending
    expect(h.state.passPending).toBe(true);
    // Scan B is for the wrong site: it is rejected locally but still claims the latest generation and clears pending.
    h.beginWrongSite();
    expect(h.state.passPending).toBe(false);
    // A now resolves valid but is stale, so it must NOT attach — the attendant saw B's rejection, not A's host.
    expect(h.resolveValid(first, { token: 'A', guest: 'Ana', unit: 'A-1', q: noHint, regions: ['MX'] })).toBe(false);
    expect(h.state.pass).toBeNull();
  });
});
