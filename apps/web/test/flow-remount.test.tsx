import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Flow, useFlow } from '../src/screens/Attendant.js';

// Render React 18 trees under act() without warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The high-severity race was that the pass-lookup generation counter lived on CheckInCapture, which remounts on the
 * capture → confirm → "edit plate" → capture navigation, resetting the counter to 0 and letting an older in-flight
 * lookup compare as current and overwrite a newer pass. The fix moved the counter onto the persistent Flow. This test
 * remounts the child that reads the counter (a new key, exactly like the route remount) while Flow stays mounted, and
 * proves the counter is the SAME ref and keeps its value — so "newest scan wins" holds across the whole flow.
 */
describe('the pass-lookup generation lives on Flow and survives a child remount', () => {
  it('keeps the same counter ref and its value when the consuming child remounts', () => {
    let captured: { current: number } | null = null;
    function Probe() {
      captured = useFlow().passSeq;
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);

    // First capture mount reads the counter and advances it twice (two scans started).
    act(() => root.render(<Flow><Probe key="mount-1" /></Flow>));
    const refOnFirstMount = captured!;
    act(() => { refOnFirstMount.current += 1; refOnFirstMount.current += 1; });
    expect(refOnFirstMount.current).toBe(2);

    // Remount the child under a new key (confirm → edit). Flow is the same element type at the same position, so it
    // does NOT remount; only Probe does.
    act(() => root.render(<Flow><Probe key="mount-2" /></Flow>));
    const refOnSecondMount = captured!;

    // Same persistent counter, value intact — a new scan here would increment past any older in-flight lookup.
    expect(refOnSecondMount).toBe(refOnFirstMount);
    expect(refOnSecondMount.current).toBe(2);

    act(() => root.unmount());
  });
});
