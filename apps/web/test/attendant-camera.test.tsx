import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criteria 3 & 4: the camera fills the plate field during check-IN and check-OUT. The real browser camera
 * (getUserMedia + the on-device model) cannot run in jsdom, so LiveCamera is replaced by buttons that emit the
 * exact `onPlate`/`onQr` payloads its reader would produce. The assertions then exercise the SHIPPED screen logic:
 * a camera read controls the visible plate field and drives navigation/match with no manual typing.
 */
const cam = vi.hoisted(() => ({ plate: '', qr: '' }));
vi.mock('../src/components/LiveCamera.js', () => ({
  LiveCamera: ({ onPlate, onQr }: { onPlate: (p: { text: string; confidence: number; votes: number }) => void; onQr: (text: string) => void }) => (
    <>
      <button type="button" onClick={() => onPlate({ text: cam.plate, confidence: 0.97, votes: 3 })}>__camera_plate__</button>
      <button type="button" onClick={() => onQr(cam.qr)}>__camera_qr__</button>
    </>
  ),
}));

const api = vi.hoisted(() => ({ request: vi.fn(), get: vi.fn() }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), request: api.request, get: api.get }));

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
const hasBtn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].some((b) => b.textContent === text);

function mount(path: '/t/torre/a/checkin' | '/t/torre/a/checkout') {
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/t/:slug/a" element={<Flow><Outlet /></Flow>}>
            <Route path="checkin" element={<CheckInCapture />} />
            <Route path="checkin/review" element={<CheckInReview />} />
            <Route path="checkin/confirm" element={<CheckInConfirm />} />
            <Route path="checkout" element={<CheckOut />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

afterEach(() => cleanup());
beforeEach(() => { api.request.mockReset(); api.get.mockReset(); });

describe('camera plate scan fills the check-in plate field (criterion 3)', () => {
  it('a confident camera read fills the visible plate and advances to confirm with no manual entry', async () => {
    withApp();
    const { container } = mount('/t/torre/a/checkin');
    cam.plate = 'XYZ789'; // a format-valid MX plate; 0.97 ≥ the 0.85 site threshold → auto-confident
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });
    // The read navigated to confirm and the scanned plate is shown in the field — the attendant typed nothing.
    await waitFor(() => { if (!(container.querySelector('.platebox')?.textContent ?? '').includes('XYZ789')) throw new Error('plate not filled from camera'); });
    expect(container.textContent ?? '').toContain(translate('en', 'att.confirm'));
  });
});

describe('unified capture: one field, camera first, keypad on manual entry', () => {
  it('check-in starts on the camera with the plate-or-code field; manual entry swaps the camera for the keypad', async () => {
    withApp();
    const { container } = mount('/t/torre/a/checkin');
    expect(hasBtn(container, '__camera_plate__')).toBe(true); // camera widget on first paint
    expect(container.querySelector('input[aria-label="Plate or code"]')).toBeTruthy();
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.manualEntry'))); });
    expect(hasBtn(container, '__camera_plate__')).toBe(false); // camera replaced, not merely hidden
    expect(container.querySelector('.keypad')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Plate or code"]')).toBeTruthy();
  });

  it('a guest-pass QR scan lands in the same plate-or-code field and goes to the pass lookup', async () => {
    withApp();
    api.get.mockResolvedValue({ valid: false, reason: 'pass_expired', pass: { guestName: '', unit: { name: '' } } });
    const { container } = mount('/t/torre/a/checkin');
    cam.qr = 'OPP2|p1|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|4102444800|SIG';
    await act(async () => { fireEvent.click(btn(container, '__camera_qr__')); });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/v1/passes/lookup?token=${encodeURIComponent(cam.qr)}`));
    expect((container.querySelector('input[aria-label="Plate or code"]') as HTMLInputElement).value).toBe(cam.qr);
  });

  it('check-out shows the single plate/ticket/pass field above the camera; manual entry swaps in the keypad', async () => {
    withApp();
    const { container } = mount('/t/torre/a/checkout');
    expect(container.querySelector('input[aria-label="Plate, ticket or guest pass"]')).toBeTruthy();
    expect(hasBtn(container, '__camera_plate__')).toBe(true); // camera visible without a Scan QR button first
    const field = container.querySelector('input[aria-label="Plate, ticket or guest pass"]')!;
    const cameraBtn = btn(container, '__camera_plate__');
    expect(field.compareDocumentPosition(cameraBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // field precedes camera
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.manualEntry'))); });
    expect(hasBtn(container, '__camera_plate__')).toBe(false);
    expect(container.querySelector('.keypad')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Plate, ticket or guest pass"]')).toBeTruthy();
  });
});

describe('camera plate scan fills the check-out plate field and matches (criterion 4)', () => {
  it('a camera read during checkout fills the plate and looks the session up by it', async () => {
    withApp();
    api.request.mockResolvedValue({ matched: false, candidates: [] });
    const { container } = mount('/t/torre/a/checkout');
    // The live camera is already open for checkout, so just read a plate.
    cam.plate = 'ABC123';
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });

    // The checkout match was requested by the camera-read plate (normalized, uppercased), with no typing.
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const [method, path, body] = api.request.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/v1/checkout/match');
    expect((body as { plate?: string }).plate).toBe('ABC123');
    // The unified field now holds the scanned value for the attendant to confirm.
    const plateInput = [...container.querySelectorAll('input')].find((i) => (i as HTMLInputElement).value === 'ABC123');
    expect(plateInput).toBeTruthy();
  });
});
