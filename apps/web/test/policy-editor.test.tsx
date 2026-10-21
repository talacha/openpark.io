import { act, useReducer } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Spy on the network write and keep the real ApiError; the useApp/useApi hooks are stubbed so the real GuestPasses
// screen mounts without a backend. canEditPassPolicy stays REAL (importActual), so this exercises the shipped gate.
const patch = vi.fn((_path?: string, _body?: unknown) => Promise.resolve({}));
const post = vi.fn((_path?: string, _body?: unknown) => Promise.resolve({}));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), patch, post }));

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

const useApi = vi.fn();
vi.mock('../src/components/hooks.js', () => ({ useApi, useLiveEvents: vi.fn(() => false) }));

// Import AFTER the mocks are registered.
const { GuestPasses } = await import('../src/screens/GuestPasses.js');

interface Policy { qrTtlMin: number; maxStayHours: number; reminderHours: [number, number]; overstayCharge: number; alertRecipients: ('host' | 'guest' | 'supervisors')[] }
const POLICY: Policy = { qrTtlMin: 120, maxStayHours: 12, reminderHours: [10, 11], overstayCharge: 500000, alertRecipients: ['host', 'guest', 'supervisors'] };

function me(roles: Role[], superadmin = false): Me {
  return {
    roles, superadmin, user: null, unit: null,
    tenant: { slug: 't', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

/**
 * A STATEFUL server stand-in: PATCH persists the policy, and the pass-policy useApi hook returns that persisted value
 * — with a STABLE identity until it actually changes, so GuestPasses' data-keyed effect doesn't loop. reload() forces
 * a re-render so the screen rehydrates from the persisted value, exactly as the real useApi/fetch cycle does. This lets
 * the test observe the saved per-tenant amount round-trip back into the UI, which the prior fixed mock could not.
 */
function mountAs(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin) });
  let store: { policy: Policy; currency: string } = { policy: { ...POLICY }, currency: 'MXN' }; // identity changes only on PATCH
  patch.mockImplementation((_path?: string, body?: unknown) => { store = { policy: body as Policy, currency: 'MXN' }; return Promise.resolve({}); });
  useApi.mockImplementation((path: string | null) => {
    const [, force] = useReducer((n: number) => n + 1, 0); // a real hook: reload() re-renders and re-reads the store
    if (path?.includes('pass-policy')) return { data: store, error: '', loading: false, reload: () => { force(); return Promise.resolve(); } };
    return { data: [] as never[], error: '', loading: false, reload: vi.fn(() => Promise.resolve()) };
  });
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}>
      <GuestPasses />
    </I18nProvider>,
  );
}

/** The overstay-charge <input> is the fifth number field (qrTtl, maxStay, reminder1, reminder2, charge). */
const chargeInput = (c: HTMLElement) => c.querySelectorAll('input[type="number"]')[4] as HTMLInputElement;
const saveButton = (c: HTMLElement) => [...c.querySelectorAll('button')].find((b) => b.textContent === 'Save') ?? null;

beforeEach(() => { patch.mockClear(); post.mockClear(); });
afterEach(() => cleanup());

describe('GuestPasses overstay-policy editor (criterion 5)', () => {
  it('persists an administrator edit and rehydrates the saved per-tenant charge on reload', async () => {
    const { container } = mountAs(['admin']);
    const charge = chargeInput(container);
    expect(charge.disabled).toBe(false);
    expect(charge.value).toBe('5000'); // 500000 minor units shown as major units (MXN)
    fireEvent.change(charge, { target: { value: '6000' } });
    const save = saveButton(container);
    expect(save).not.toBeNull();
    // save() PATCHes then reload()s; both state updates flush inside act().
    await act(async () => { fireEvent.click(save!); });

    // The PATCH carried integer minor units for this tenant.
    expect(patch).toHaveBeenCalledTimes(1);
    const [path, body] = patch.mock.calls[0]!;
    expect(path).toBe('/v1/pass-policy');
    expect((body as { overstayCharge: number }).overstayCharge).toBe(600000); // 6000 major → 600000 minor

    // After the save+reload round-trip the screen shows the PERSISTED value, not just the local edit.
    expect(chargeInput(container).value).toBe('6000');

    // A fresh mount (a reload of the page) reads the persisted value straight from the server stand-in.
    cleanup();
    const remount = render(<I18nProvider defaultLocale="en" terminology={{}}><GuestPasses /></I18nProvider>);
    expect(chargeInput(remount.container).value).toBe('6000');
  });

  it('shows a supervisor a read-only editor: inputs disabled, no Save, no PATCH possible', () => {
    const { container } = mountAs(['supervisor']);
    const inputs = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.disabled)).toBe(true); // every editable policy control is disabled
    expect(saveButton(container)).toBeNull(); // the Save control is not even rendered for supervisors
    expect(patch).not.toHaveBeenCalled();
  });
});
