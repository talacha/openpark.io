import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criteria 6 & 7 through the REAL admin screens: an administrator performs representative entity CRUD (a unit:
 * create → edit → delete), a non-admin sees a read-only screen with no write affordances, and the Super-Admin
 * cross-property control is gated — a Super Admin can target a second property (triggering that property's data load)
 * while a regular administrator never sees the switch and so cannot read or mutate another property's entities.
 */
const api = vi.hoisted(() => ({ request: vi.fn(() => Promise.resolve({})), patch: vi.fn(() => Promise.resolve({})), del: vi.fn(() => Promise.resolve({})), post: vi.fn(() => Promise.resolve({})) }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), request: api.request, patch: api.patch, del: api.del, post: api.post }));

const paths = vi.hoisted(() => ({ list: [] as string[] }));
const useApi = vi.fn();
vi.mock('../src/components/hooks.js', () => ({ useApi, useLiveEvents: vi.fn(() => false) }));

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

const { Units, People } = await import('../src/screens/People.js');

function me(roles: Role[], superadmin = false): Me {
  return {
    roles, superadmin, user: { id: 'u1', email: 'me@torre.mx', name: 'Me', phone: null, locale: 'en' }, unit: null,
    tenant: { slug: 't', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

const UNITS = [{ code: 'A-1', name: 'Apt 1', site: null, floor: 1, note: null, residents: [], pass_status: null }];

function setupApi() {
  paths.list = [];
  useApi.mockImplementation((path: string | null) => {
    if (path) paths.list.push(path);
    const data = path === '/v1/units' ? UNITS
      : path === '/v1/users' ? { members: [], invites: [] }
      : path === '/v1/platform/tenants' ? [{ slug: 't', name: 'Torre' }, { slug: 'other', name: 'Other' }]
      : path?.includes('/units') ? [] // a platform tenant's units
      : null;
    return { data, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) };
  });
}

function mountUnits(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin), sites: [] });
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter><Units /></MemoryRouter></I18nProvider>,
  );
}
function mountPeople(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin), sites: [] });
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter><People /></MemoryRouter></I18nProvider>,
  );
}

const byText = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].filter((b) => b.textContent === text);

beforeEach(() => { setupApi(); api.request.mockClear(); api.patch.mockClear(); api.del.mockClear(); });
afterEach(() => cleanup());

describe('Administrator unit CRUD through the real screen (criterion 6)', () => {
  it('creates a unit (POST), edits it (PATCH), and deletes it (DELETE)', async () => {
    const { container } = mountUnits(['admin']);

    // CREATE
    (container.querySelector('input[name="code"]') as HTMLInputElement).value = '';
    fireEvent.change(container.querySelector('input[name="code"]')!, { target: { value: 'B-2' } });
    fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: 'Apt 2' } });
    await act(async () => { fireEvent.click(byText(container, translate('en', 'units.add'))[0]!); });
    expect(api.request).toHaveBeenCalledTimes(1);
    const [method, path, body] = api.request.mock.calls[0]!;
    expect([method, path]).toEqual(['POST', '/v1/units']);
    expect(body as Record<string, unknown>).toMatchObject({ code: 'B-2', name: 'Apt 2' });

    // EDIT the existing row
    await act(async () => { fireEvent.click(byText(container, translate('en', 'users.edit'))[0]!); });
    const editForm = container.querySelector(`form[aria-label="${translate('en', 'users.editing', { who: 'A-1' })}"]`) as HTMLFormElement;
    expect(editForm).toBeTruthy();
    fireEvent.change(editForm.querySelector('input[name="name"]')!, { target: { value: 'Apt 1 renamed' } });
    await act(async () => { fireEvent.click(byText(editForm, translate('en', 'common.save'))[0]!); });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]![0]).toBe('/v1/units/A-1');
    expect(api.patch.mock.calls[0]![1] as Record<string, unknown>).toMatchObject({ name: 'Apt 1 renamed' });

    // DELETE the row
    await act(async () => { fireEvent.click(byText(container, translate('en', 'common.remove'))[0]!); });
    expect(api.del).toHaveBeenCalledWith('/v1/units/A-1');
  });

  it('gives a non-admin a read-only screen: no create form and no edit/remove controls', () => {
    const { container } = mountUnits(['attendant']);
    expect(container.querySelector('input[name="code"]')).toBeNull(); // the add form is not rendered
    expect(byText(container, translate('en', 'users.edit'))).toHaveLength(0);
    expect(byText(container, translate('en', 'common.remove'))).toHaveLength(0);
  });
});

describe('Super Admin cross-property boundary (criterion 7)', () => {
  it('a Super Admin can target a second property, loading that property’s entities', async () => {
    const { container } = mountPeople(['admin'], true);
    const propSelect = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === 'Other'))!;
    expect(propSelect).toBeTruthy(); // the property switch is offered to a Super Admin
    await act(async () => { fireEvent.change(propSelect, { target: { value: 'other' } }); });
    // Switching property loads THAT property's units through the platform-scoped endpoint.
    expect(paths.list).toContain('/v1/platform/tenants/other/units');
  });

  it('a regular administrator never sees the property switch and cannot reach another property', () => {
    const { container } = mountPeople(['admin'], false);
    const hasSwitch = [...container.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.textContent === 'Other'));
    expect(hasSwitch).toBe(false); // no cross-property control
    expect(paths.list).not.toContain('/v1/platform/tenants'); // and no platform-scoped fetch is issued
  });
});
