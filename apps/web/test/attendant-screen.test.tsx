import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The server pass lookup is the only network call on this path; stub it and keep the rest of the api module real.
const apiGet = vi.fn();
vi.mock('../src/api.js', async (io) => ({ ...(await io()), get: apiGet }));

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

// Import AFTER the mocks are registered.
const { CheckInCapture, Flow } = await import('../src/screens/Attendant.js');

const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: {}, zones: [] };
function me(): Me {
  return {
    roles: ['attendant'], superadmin: false, user: null, unit: null,
    // ai_mode 'off' keeps the camera (LiveCamera/getUserMedia) out of the render, so the scan/type-code path is exercised in jsdom.
    tenant: { slug: 'torre', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

function mount() {
  useApp.mockReturnValue({ me: me(), site: SITE });
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}>
      <MemoryRouter initialEntries={['/t/torre/a/checkin']}>
        <Flow><CheckInCapture /></Flow>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const HINTED = 'OPP2|p1|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|4102444800|SIG'; // valid, plate hint ABC123

async function typeAndUse(container: HTMLElement, token: string) {
  const input = container.querySelector('input[aria-label="Pass code"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value: token } });
  const use = [...container.querySelectorAll('button')].find((b) => b.textContent === translate('en', 'att.passUse'))!;
  await act(async () => { fireEvent.click(use); });
}

afterEach(() => cleanup());
beforeEach(() => apiGet.mockReset());

describe('CheckInCapture: a scanned/typed pass prepopulates and verifies the check-in (criterion 2)', () => {
  it('accepts a valid hinted pass, prefills the editable plate field, and announces + focuses the result', async () => {
    apiGet.mockResolvedValue({ valid: true, reason: null, pass: { guestName: 'Rosa', unit: { name: 'A-101' } } });
    const { container } = mount();
    await typeAndUse(container, HINTED);

    // The lookup hit the server with the exact token, so an expired/foreign code is rejected before any walk-in.
    expect(apiGet).toHaveBeenCalledWith(`/v1/passes/lookup?token=${encodeURIComponent(HINTED)}`);

    const banner = await waitFor(() => {
      const b = container.querySelector('[role="status"]') as HTMLElement;
      if (!b || !b.textContent) throw new Error('pass banner not shown yet');
      return b;
    });
    const text = banner.textContent ?? '';
    expect(text).toContain(translate('en', 'att.passFor', { guest: 'Rosa', unit: 'A-101' }));
    expect(text).toContain(translate('en', 'att.passVerified', { code: 'K7Q2 M9XA' }));
    expect(text).toContain(translate('en', 'att.passPlateHint', { plate: 'ABC123' }));
    // The hint actually fills the visible, editable plate field (not just the banner).
    expect((container.querySelector('.platebox')?.textContent ?? '')).toContain('ABC123');
    // Focus lands on the result for keyboard / screen-reader users.
    expect(document.activeElement).toBe(banner);
  });

  it('persists a rejected pass as a blocking alert and clears it only on explicit acknowledgment', async () => {
    apiGet.mockResolvedValue({ valid: false, reason: 'pass_expired', pass: { guestName: '', unit: { name: '' } } });
    const { container } = mount();
    await typeAndUse(container, HINTED);

    const alert = await waitFor(() => {
      const a = container.querySelector('.banner.bad[role="alert"]') as HTMLElement;
      if (!a) throw new Error('rejection alert not shown yet');
      return a;
    });
    expect(alert.textContent ?? '').toContain(translate('en', 'pass.reason_pass_expired'));
    expect(container.querySelector('[role="status"]')).toBeNull(); // no accepted pass banner
    expect(document.activeElement).toBe(alert); // the failure takes focus, not something past it

    // "Dismiss and scan again" is the explicit acknowledgment that clears the persisted rejection.
    const dismiss = [...alert.querySelectorAll('button')].find((b) => b.textContent === translate('en', 'att.passDismiss'))!;
    await act(async () => { fireEvent.click(dismiss); });
    expect(container.querySelector('.banner.bad[role="alert"]')).toBeNull();
  });
});
