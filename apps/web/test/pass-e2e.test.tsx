import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criterion 1 + 2, end to end through the REAL screens: a resident's shared pass link opens the public guest page,
 * the QR it renders on the guest device is decoded back to the exact signed token, and that same decoded token — fed
 * through the attendant's scanner — prepopulates the check-in form, is verified/edited, and is redeemed at the gate.
 * This closes the review gap that earlier tests mounted components in isolation and never joined the artifact to redemption.
 */

// The scanner fires this payload; set per test so the attendant scans the exact token the guest page produced.
const h = vi.hoisted(() => ({ scanToken: '' }));

// Keep decodeQr REAL (so we decode the artifact the guest page actually rendered); swap only the camera UI for a button.
vi.mock('../src/components/QrScanner.js', () => ({
  QrScanner: ({ onResult }: { onResult: (t: string) => void; onClose: () => void }) => (
    <button type="button" onClick={() => onResult(h.scanToken)}>__scan__</button>
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

// Import AFTER the mocks are registered.
const { CheckInCapture, CheckInConfirm, CheckInReview, Flow } = await import('../src/screens/Attendant.js');
const { GuestPass } = await import('../src/screens/GuestPass.js');
const { decodeQr } = await import('../src/qr.js');
const { passShareUrl } = await import('../src/pass.js');

const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: {}, zones: [] };
function me(): Me {
  return {
    roles: ['attendant'], superadmin: false, user: null, unit: null,
    tenant: { slug: 'torre', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

// A live, signed guest-pass token: guest Rosa, unit A-101, site DEMO-01, plate hint ABC123, expiry in 2100.
const TOKEN = 'OPP2|p1|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|4102444800|AbCdEfGhIjKlMnOpQrStUv';

/** Decode the QR the guest page ACTUALLY rendered: parse the inline SVG's dark modules and rasterize them for jsQR. */
function decodeRenderedQr(svgHtml: string): string | null {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svgHtml);
  if (!vb) return null;
  const cell = 4; // QrCode renders with cellSize 4
  const total = Number(vb[1]) / cell; // padded module grid (quiet zone included)
  const coords = [...svgHtml.matchAll(/M(\d+),(\d+)/g)].map((m) => [Number(m[1]) / cell, Number(m[2]) / cell] as const);
  if (!coords.length) return null;
  const qz = Math.min(...coords.map(([c, r]) => Math.min(c, r))); // quiet-zone offset = finder pattern origin
  const count = total - qz * 2;
  const grid: boolean[][] = Array.from({ length: count }, () => Array<boolean>(count).fill(false));
  for (const [c, r] of coords) { const cc = c - qz, rr = r - qz; if (rr >= 0 && cc >= 0 && rr < count && cc < count) grid[rr]![cc] = true; }
  // Rasterize exactly like a camera frame (scale 6, 4-module quiet zone) — the pipeline qr.test.ts proves is decodable.
  const scale = 6, margin = 4, size = (count + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.floor(y / scale) - margin, c = Math.floor(x / scale) - margin;
    const dark = r >= 0 && c >= 0 && r < count && c < count && grid[r]![c];
    const v = dark ? 0 : 255;
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
  return decodeQr({ data, width: size, height: size });
}

function mountAttendant() {
  ctx.useApp.mockReturnValue({ me: me(), site: SITE });
  return render(
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
}

const btn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

afterEach(() => { cleanup(); window.location.hash = ''; });
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.write.mockReset(); });

describe('resident share → guest page → attendant scan → gate redemption (criteria 1 & 2)', () => {
  it('decodes the QR the public guest page renders back to the exact shared token', () => {
    // The resident shares this fragment URL; the guest opens it unauthenticated.
    window.location.hash = new URL(passShareUrl('http://localhost', TOKEN)).hash;
    ctx.useApp.mockReturnValue({ me: me(), site: SITE });
    const { container } = render(
      <I18nProvider defaultLocale="en" terminology={{}}><GuestPass /></I18nProvider>,
    );
    // The guest page shows the guest/unit line and a rendered QR with no authentication.
    expect(container.textContent ?? '').toContain(translate('en', 'guest.for', { guest: 'Rosa', unit: 'A-101' }));
    const svg = (container.querySelector('.qr')?.innerHTML ?? '');
    expect(svg).toContain('<svg');
    expect(decodeRenderedQr(svg)).toBe(TOKEN); // the on-screen artifact decodes to the exact signed token
  });

  it('a scanned token prepopulates the editable plate, is edited, and redeems at the gate (never a walk-in)', async () => {
    // Start from the decoded artifact so the attendant scans exactly what the guest displayed.
    window.location.hash = new URL(passShareUrl('http://localhost', TOKEN)).hash;
    ctx.useApp.mockReturnValue({ me: me(), site: SITE });
    const guest = render(<I18nProvider defaultLocale="en" terminology={{}}><GuestPass /></I18nProvider>);
    const decoded = decodeRenderedQr(guest.container.querySelector('.qr')!.innerHTML)!;
    expect(decoded).toBe(TOKEN);
    cleanup();

    api.get.mockResolvedValue({ valid: true, reason: null, pass: { guestName: 'Rosa', unit: { name: 'A-101' } } });
    api.post.mockResolvedValue({ session: { id: 's1', ticketCode: 'T-1' }, slot: 'A1', warnings: [] });
    h.scanToken = decoded;

    const { container } = mountAttendant();

    // Open the scanner and read the guest's QR (the camera path, not a typed code).
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.scanPass'))); });
    const scan = await waitFor(() => btn(container, '__scan__'));
    await act(async () => { fireEvent.click(scan); });

    // The server lookup was hit with the exact scanned token, so a bad QR is caught at the gate before any check-in.
    expect(api.get).toHaveBeenCalledWith(`/v1/passes/lookup?token=${encodeURIComponent(TOKEN)}`);

    // AC-4.2.2: a successful scan lands DIRECTLY on the complete prefilled confirmation form (Host/vehicle/Slot), not a
    // plate-only capture step. The pass guest banner and the editable Plate field (prefilled with the hint ABC123) show there.
    const plate = () => container.querySelector('input[aria-required="true"]') as HTMLInputElement;
    await waitFor(() => { if (plate()?.value !== 'ABC123') throw new Error('plate not prefilled on confirm'); });
    expect(container.textContent ?? '').toContain(translate('en', 'att.passFor', { guest: 'Rosa', unit: 'A-101' }));
    // The host is fixed to the pass unit and the vehicle/slot sections are present on this same form.
    expect(container.textContent ?? '').toContain(translate('en', 'att.vehicle'));

    // The attendant verifies and REPLACES the plate on the confirmation form before submitting.
    await act(async () => { fireEvent.change(plate(), { target: { value: 'XYZ789' } }); });
    expect(plate().value).toBe('XYZ789');

    // Submit the redemption from the confirmation form.
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.confirm'))); });

    // Redemption goes through /v1/passes/redeem with the intended token and the edited plate — never the walk-in branch.
    expect(api.write).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body] = api.post.mock.calls[0]!;
    expect(path).toBe('/v1/passes/redeem');
    expect((body as { token: string }).token).toBe(TOKEN);
    expect((body as { plate: { display: string; region: string } }).plate).toEqual({ display: 'XYZ789', region: 'MX' });
  });
});
