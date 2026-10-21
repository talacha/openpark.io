import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criterion 2 + accessibility: when a pass lookup is still in flight and a camera plate read has already navigated to
 * the Confirm screen, a lookup that then REJECTS must (a) block the walk-in submission and (b) move keyboard/screen
 * reader focus onto the rejection alert on Confirm — mirroring the capture screen, which already does this. This test
 * drives the real routed screens; only the camera hardware (getUserMedia + on-device model) is faked at the boundary.
 */

const cam = vi.hoisted(() => ({ token: '', plate: '' }));
vi.mock('../src/components/LiveCamera.js', () => ({
  LiveCamera: ({ onQr, onPlate }: { onQr: (t: string) => void; onPlate: (p: { text: string; confidence: number; votes: number }) => void }) => (
    <>
      <button type="button" onClick={() => onQr(cam.token)}>__camera_qr__</button>
      <button type="button" onClick={() => onPlate({ text: cam.plate, confidence: 0.97, votes: 3 })}>__camera_plate__</button>
    </>
  ),
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), write: vi.fn() }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), get: api.get, post: api.post, write: api.write }));

vi.mock('../src/components/hooks.js', () => ({
  useApi: () => ({ data: null, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) }),
  useLiveEvents: () => false,
}));

const ctx = vi.hoisted(() => ({ useApp: vi.fn() }));
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp: ctx.useApp }));

const { CheckInCapture, CheckInConfirm, CheckInReview, Flow } = await import('../src/screens/Attendant.js');

const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: { aiThreshold: 0.85 }, zones: [] };
function me(): Me {
  return {
    roles: ['attendant'], superadmin: false, user: null, unit: null,
    tenant: { slug: 'torre', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'assist', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

// A live, signed guest-pass token for site DEMO-01, plate hint ABC123.
const TOKEN = 'OPP2|p1|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|4102444800|AbCdEfGhIjKlMnOpQrStUv';

const btn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

afterEach(() => cleanup());
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.write.mockReset(); });

describe('a pass that rejects after the camera navigated to Confirm (criterion 2 + a11y)', () => {
  it('focuses the Confirm rejection alert, blocks the walk-in, and acknowledges back to capture', async () => {
    ctx.useApp.mockReturnValue({ me: me(), site: SITE });
    // Hold the lookup open so the camera plate read can navigate to Confirm while it is still pending.
    let rejectAs: (v: { valid: boolean; reason: string | null; pass: unknown }) => void = () => {};
    api.get.mockReturnValue(new Promise((res) => { rejectAs = res; }));

    const { container } = render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <MemoryRouter initialEntries={['/t/torre/a/checkin']}>
          <Routes>
            <Route path="/t/:slug/a" element={<Flow><Outlet /></Flow>}>
              <Route path="checkin" element={<CheckInCapture />} />
              <Route path="checkin/review" element={<CheckInReview />} />
              <Route path="checkin/confirm" element={<CheckInConfirm />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    // 1) A scanned QR starts the lookup (now pending).
    cam.token = TOKEN;
    await act(async () => { fireEvent.click(btn(container, '__camera_qr__')); });
    // 2) A camera plate read lands and navigates to Confirm while the lookup is still in flight.
    cam.plate = 'XYZ789';
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });
    await waitFor(() => { if (!container.textContent?.includes(translate('en', 'att.confirm'))) throw new Error('not on confirm'); });

    // 3) The lookup now rejects. The rejection must surface on Confirm and take focus.
    await act(async () => { rejectAs({ valid: false, reason: 'pass_expired', pass: null }); });
    const alert = await waitFor(() => {
      const el = container.querySelector('.banner.bad[role="alert"]') as HTMLElement | null;
      if (!el) throw new Error('rejection alert not shown on confirm');
      return el;
    });
    expect(document.activeElement).toBe(alert); // keyboard/SR users land on the failure, not past it

    // The walk-in submit is blocked while the rejection is unacknowledged, and nothing was ever written.
    const confirmBtn = btn(container, translate('en', 'att.confirm')) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(api.write).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();

    // Acknowledging returns the attendant to the capture screen to re-scan.
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.passDismiss'))); });
    await waitFor(() => { if (!container.textContent?.includes(translate('en', 'att.scanPass'))) throw new Error('did not return to capture'); });
    expect(api.write).not.toHaveBeenCalled();
  });
});
