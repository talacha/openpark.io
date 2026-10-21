import { act } from 'react';
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

const POLICY = { qrTtlMin: 120, maxStayHours: 12, reminderHours: [10, 11] as [number, number], overstayCharge: 500000, alertRecipients: ['host', 'guest', 'supervisors'] as ('host' | 'guest' | 'supervisors')[] };

function me(roles: Role[], superadmin = false): Me {
  return {
    roles, superadmin, user: null, unit: null,
    tenant: { slug: 't', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

function mountAs(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin) });
  // The references MUST be stable across renders: GuestPasses copies res.data into state in an effect keyed on
  // res.data, so a fresh object each call would loop forever. Mirrors the real useApi, whose data identity is stable.
  const policyResult = { data: { policy: { ...POLICY }, currency: 'MXN' }, error: '', loading: false, reload: vi.fn(() => Promise.resolve()) };
  const listResult = { data: [] as never[], error: '', loading: false, reload: vi.fn(() => Promise.resolve()) };
  useApi.mockImplementation((path: string | null) => (path?.includes('pass-policy') ? policyResult : listResult));
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
  it('lets an administrator change the per-tenant charge and PATCHes it in integer minor units', async () => {
    const { container } = mountAs(['admin']);
    const charge = chargeInput(container);
    expect(charge.disabled).toBe(false);
    expect(charge.value).toBe('5000'); // 500000 minor units shown as 5000.00 major units (MXN)
    fireEvent.change(charge, { target: { value: '6000' } });
    const save = saveButton(container);
    expect(save).not.toBeNull();
    // save() awaits the PATCH then sets a status + reloads; flush those state updates inside act().
    await act(async () => { fireEvent.click(save!); });
    expect(patch).toHaveBeenCalledTimes(1);
    const [path, body] = patch.mock.calls[0]!;
    expect(path).toBe('/v1/pass-policy');
    expect((body as { overstayCharge: number }).overstayCharge).toBe(600000); // 6000 major → 600000 minor
  });

  it('shows a supervisor a read-only editor: inputs disabled, no Save, no PATCH possible', () => {
    const { container } = mountAs(['supervisor']);
    expect(chargeInput(container).disabled).toBe(true);
    expect(saveButton(container)).toBeNull(); // the Save control is not even rendered for supervisors
    expect(patch).not.toHaveBeenCalled();
  });
});
