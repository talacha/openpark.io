import { describe, expect, it } from 'vitest';
import { applyPassAccept, applyPassRemove, emptyFlow, type FlowState } from '../src/attendant-flow.js';
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
