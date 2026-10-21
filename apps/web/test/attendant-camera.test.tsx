import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criteria 3 & 4: the camera fills the plate field during check-IN and check-OUT. The real browser camera
 * (getUserMedia + the on-device model) cannot run in jsdom, so LiveCamera is replaced by a button that emits the
 * exact `onPlate` payload its reader would produce. The assertions then exercise the SHIPPED screen logic: a camera
 * read controls the visible plate field and drives navigation/match with no manual typing.
 */
const cam = vi.hoisted(() => ({ plate: '' }));
vi.mock('../src/components/LiveCamera.js', () => ({
  LiveCamera: ({ onPlate }: { onPlate: (p: { text: string; confidence: number; votes: number }) => void }) => (
    <button type="button" onClick={() => onPlate({ text: cam.plate, confidence: 0.97, votes: 3 })}>__camera_plate__</button>
  ),
}));

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), request: api.request }));

vi.mock('../src/components/hooks.js', () => ({
  useApi: () => ({ data: null, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) }),
  useLiveEvents: () => false,
}));

const ctx = vi.hoisted(() => ({ useApp: vi.fn() }));
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp: ctx.useApp }));

const { CheckInCapture, CheckInConfirm, CheckInReview, CheckOut, Flow } = await import('../src/screens/Attendant.js');

const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: { aiThreshold: 0.85 }, zones: [] };
function me(): Me {
  return {
    roles: ['attendant'], superadmin: false, user: null, unit: null,
    // ai_mode 'assist' turns the camera on, so LiveCamera (here, our fake) is rendered.
    tenant: { slug: 'torre', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'assist', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}
const withApp = () => ctx.useApp.mockReturnValue({ me: me(), site: SITE, can: () => false });

const btn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

afterEach(() => cleanup());
beforeEach(() => { api.request.mockReset(); });

describe('camera plate scan fills the check-in plate field (criterion 3)', () => {
  it('a confident camera read fills the visible plate and advances to confirm with no manual entry', async () => {
    withApp();
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
    cam.plate = 'XYZ789'; // a format-valid MX plate; 0.97 ≥ the 0.85 site threshold → auto-confident
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });
    // The read navigated to confirm and the scanned plate is shown in the field — the attendant typed nothing.
    await waitFor(() => { if (!(container.querySelector('.platebox')?.textContent ?? '').includes('XYZ789')) throw new Error('plate not filled from camera'); });
    expect(container.textContent ?? '').toContain(translate('en', 'att.confirm'));
  });
});

describe('camera plate scan fills the check-out plate field and matches (criterion 4)', () => {
  it('a camera read during checkout fills the plate and looks the session up by it', async () => {
    withApp();
    api.request.mockResolvedValue({ matched: false, candidates: [] });
    const { container } = render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <MemoryRouter initialEntries={['/t/torre/a/checkout']}>
          <Routes>
            <Route path="/t/:slug/a" element={<Flow><Outlet /></Flow>}>
              <Route path="checkout" element={<CheckOut />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    // Open the live camera for checkout, then read a plate.
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.scanQr'))); });
    cam.plate = 'ABC123';
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });

    // The checkout match was requested by the camera-read plate (normalized, uppercased), with no typing.
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const [method, path, body] = api.request.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/v1/checkout/match');
    expect((body as { plate?: string }).plate).toBe('ABC123');
    // The plate field now holds the scanned value for the attendant to confirm.
    const plateInput = [...container.querySelectorAll('input')].find((i) => (i as HTMLInputElement).value === 'ABC123');
    expect(plateInput).toBeTruthy();
  });
});
