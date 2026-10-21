import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Criteria 6 & 7 through the REAL admin screens at a mobile viewport: an administrator performs representative entity
 * CRUD — a UNIT (create → edit → delete), a PERSON (create), and SITE/ZONE/SLOT (create, plus slot delete) — each write
 * carrying a submission-scoped Idempotency-Key that a lost-response retry REUSES (so the retry replays instead of a false
 * conflict). A non-admin sees a read-only screen with no write affordances. The Super-Admin cross-property control is
 * gated: a Super Admin can target a second property AND write into it, while a regular administrator never sees the
 * switch and issues no platform-scoped request. (The regular-admin API denial itself is proven in apps/api/test/api.test.ts.)
 */
const api = vi.hoisted(() => ({ request: vi.fn(() => Promise.resolve({})), patch: vi.fn(() => Promise.resolve({})), del: vi.fn(() => Promise.resolve({})), post: vi.fn(() => Promise.resolve({})) }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), request: api.request, patch: api.patch, del: api.del, post: api.post }));

// Keep the REAL useSubmitKey (so the submission-scoped-key behaviour is exercised, not stubbed); mock only data hooks.
const paths = vi.hoisted(() => ({ list: [] as string[] }));
const useApi = vi.fn();
vi.mock('../src/components/hooks.js', async (io) => ({ ...(await io()), useApi, useLiveEvents: vi.fn(() => false) }));

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

const { Units, People } = await import('../src/screens/People.js');
const { Parking } = await import('../src/screens/Parking.js');

function me(roles: Role[], superadmin = false): Me {
  return {
    roles, superadmin, user: { id: 'u1', email: 'me@torre.mx', name: 'Me', phone: null, locale: 'en' }, unit: null,
    tenant: { slug: 't', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [{ code: 'standard', label: { en: 'Standard' } }], retention_days: 365, training_export: false },
  };
}

const UNITS = [{ code: 'A-1', name: 'Apt 1', site: null, floor: 1, note: null, residents: [], pass_status: null }];
const SITES = [{ code: 'S1', name: 'Site One', timezone: 'America/Mexico_City', address: null, settings: {}, slots: 1, open_sessions: 0, zones: [{ code: 'Z1', name: 'Zone One', labels: {}, level: 1, slots: 1 }] }];
const SLOTS = [{ code: 'P0', zone: 'Z1', type: 'standard', status: 'available', note: null, plate: null }];

function setupApi() {
  paths.list = [];
  useApi.mockImplementation((path: string | null) => {
    if (path) paths.list.push(path);
    const data = path === '/v1/units' ? UNITS
      : path === '/v1/users' ? { members: [], invites: [] }
      : path === '/v1/sites' ? SITES
      : path?.startsWith('/v1/slots?site=') ? SLOTS
      : path === '/v1/platform/tenants' ? [{ slug: 't', name: 'Torre' }, { slug: 'other', name: 'Other' }]
      : path?.includes('/units') ? [] // a platform tenant's units
      : null;
    return { data, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) };
  });
}

/** jsdom has no layout engine, but render at a 390px mobile width so the screens mount under the narrow viewport. */
function narrow() { Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true }); window.dispatchEvent(new Event('resize')); }

function mountUnits(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin), sites: [], reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter><Units /></MemoryRouter></I18nProvider>);
}
function mountPeople(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin), sites: [], reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter><People /></MemoryRouter></I18nProvider>);
}
function mountParking(roles: Role[], superadmin = false) {
  useApp.mockReturnValue({ me: me(roles, superadmin), sites: [], reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter><Parking /></MemoryRouter></I18nProvider>);
}

const byText = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].filter((b) => b.textContent === text);
const formOf = (c: HTMLElement, buttonText: string) => byText(c, buttonText)[0]!.closest('form') as HTMLFormElement;
const rowWith = (c: HTMLElement, text: string) => [...c.querySelectorAll('tr')].find((tr) => (tr.textContent ?? '').includes(text))!;

beforeEach(() => { narrow(); setupApi(); api.request.mockClear(); api.patch.mockClear(); api.del.mockClear(); api.post.mockReset(); api.post.mockResolvedValue({}); });
afterEach(() => cleanup());

describe('Administrator unit CRUD through the real screen (criterion 6)', () => {
  it('creates a unit (POST), edits it (PATCH), and deletes it (DELETE)', async () => {
    const { container } = mountUnits(['admin']);

    // CREATE
    fireEvent.change(container.querySelector('input[name="code"]')!, { target: { value: 'B-2' } });
    fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: 'Apt 2' } });
    await act(async () => { fireEvent.click(byText(container, translate('en', 'units.add'))[0]!); });
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body, key] = api.post.mock.calls[0]!;
    expect(path).toBe('/v1/units');
    expect(body as Record<string, unknown>).toMatchObject({ code: 'B-2', name: 'Apt 2' });
    expect(typeof key).toBe('string'); // a submission-scoped Idempotency-Key is sent

    // EDIT the existing row
    await act(async () => { fireEvent.click(byText(container, translate('en', 'users.edit'))[0]!); });
    const editForm = container.querySelector(`form[aria-label="${translate('en', 'users.editing', { who: 'A-1' })}"]`) as HTMLFormElement;
    expect(editForm).toBeTruthy();
    fireEvent.change(editForm.querySelector('input[name="name"]')!, { target: { value: 'Apt 1 renamed' } });
    await act(async () => { fireEvent.click(byText(editForm, translate('en', 'common.save'))[0]!); });
    expect(api.patch).toHaveBeenCalledWith('/v1/units/A-1', expect.objectContaining({ name: 'Apt 1 renamed' }));

    // DELETE the row
    await act(async () => { fireEvent.click(byText(container, translate('en', 'common.remove'))[0]!); });
    expect(api.del).toHaveBeenCalledWith('/v1/units/A-1');
  });

  it('reuses one submission-scoped Idempotency-Key across a lost-response retry, then rotates after success', async () => {
    api.post.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue({});
    const { container } = mountUnits(['admin']);
    const fill = (code: string, name: string) => {
      fireEvent.change(container.querySelector('input[name="code"]')!, { target: { value: code } });
      fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: name } });
    };
    const addBtn = () => byText(container, translate('en', 'units.add'))[0]!;

    fill('B-2', 'Apt 2');
    await act(async () => { fireEvent.click(addBtn()); }); // first submit: the response is lost
    await act(async () => { fireEvent.click(addBtn()); }); // the attendant retries the SAME submission

    expect(api.post).toHaveBeenCalledTimes(2);
    const k1 = api.post.mock.calls[0]![2];
    const k2 = api.post.mock.calls[1]![2];
    expect(typeof k1).toBe('string');
    expect(k2).toBe(k1); // the retry replays under the SAME key — not a fresh random one — so it cannot double-create

    // A genuinely new unit, created after the success, uses a fresh key (the server would store it separately).
    fill('C-3', 'Apt 3');
    await act(async () => { fireEvent.click(addBtn()); });
    expect(api.post.mock.calls[2]![2]).not.toBe(k1);
  });

  it('rotates to a FRESH key when the payload is deliberately edited after a lost response, so the retry cannot loop on idempotency_key_reuse', async () => {
    // The first write's response is lost but the write may have committed. The user then edits a field and resubmits:
    // the new body must travel under a NEW key, otherwise the server rejects the stored key replayed with a different
    // body (idempotency_key_reuse) and the form is stuck in a permanent 422 loop.
    api.post.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue({});
    const { container } = mountUnits(['admin']);
    const fill = (code: string, name: string) => {
      fireEvent.change(container.querySelector('input[name="code"]')!, { target: { value: code } });
      fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: name } });
    };
    const addBtn = () => byText(container, translate('en', 'units.add'))[0]!;

    fill('B-2', 'Apt 2');
    await act(async () => { fireEvent.click(addBtn()); }); // first submit: response lost
    fill('B-3', 'Apt 3'); // the user deliberately CHANGES the payload before retrying
    await act(async () => { fireEvent.click(addBtn()); });

    expect(api.post).toHaveBeenCalledTimes(2);
    const k1 = api.post.mock.calls[0]![2];
    const k2 = api.post.mock.calls[1]![2];
    expect(typeof k1).toBe('string');
    expect(k2).not.toBe(k1); // a changed payload is a fresh request under a NEW key — no 422 reuse loop
    expect((api.post.mock.calls[1]![1] as { code: string }).code).toBe('B-3');
  });

  it('gives a non-admin a read-only screen: no create form and no edit/remove controls', () => {
    const { container } = mountUnits(['attendant']);
    expect(container.querySelector('input[name="code"]')).toBeNull();
    expect(byText(container, translate('en', 'users.edit'))).toHaveLength(0);
    expect(byText(container, translate('en', 'common.remove'))).toHaveLength(0);
  });
});

describe('Administrator person CRUD through the real screen (criterion 6)', () => {
  it('creates a person with a submission-scoped Idempotency-Key', async () => {
    const { container } = mountPeople(['admin']);
    const form = formOf(container, translate('en', 'users.invite'));
    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: 'nuevo@torre.mx' } });
    await act(async () => { fireEvent.click(byText(form, translate('en', 'users.invite'))[0]!); });
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body, key] = api.post.mock.calls[0]!;
    expect(path).toBe('/v1/users'); // the current property
    expect((body as { email: string }).email).toBe('nuevo@torre.mx');
    expect((body as { roles: string[] }).roles).toEqual(['attendant']);
    expect(typeof key).toBe('string');
  });
});

describe('Administrator site, zone and slot CRUD through the real screen (criterion 6)', () => {
  it('creates a site, a zone and a slot, and deletes a slot — each create carrying a key', async () => {
    const { container } = mountParking(['admin']);

    // CREATE SITE
    const siteForm = formOf(container, translate('en', 'parking.addSite'));
    fireEvent.change(siteForm.querySelector('input[name="code"]')!, { target: { value: 'S2' } });
    fireEvent.change(siteForm.querySelector('input[name="name"]')!, { target: { value: 'Site Two' } });
    await act(async () => { fireEvent.click(byText(siteForm, translate('en', 'parking.addSite'))[0]!); });
    expect(api.post.mock.calls.at(-1)![0]).toBe('/v1/sites');
    expect(typeof api.post.mock.calls.at(-1)![2]).toBe('string');

    // Expand the existing site to reach its zone/slot management.
    await act(async () => { fireEvent.click(byText(container, translate('en', 'parking.manage'))[0]!); });

    // CREATE ZONE
    const zoneForm = formOf(container, translate('en', 'parking.addZone'));
    fireEvent.change(zoneForm.querySelector('input[name="code"]')!, { target: { value: 'Z2' } });
    fireEvent.change(zoneForm.querySelector('input[name="name"]')!, { target: { value: 'Zone Two' } });
    await act(async () => { fireEvent.click(byText(zoneForm, translate('en', 'parking.addZone'))[0]!); });
    expect(api.post.mock.calls.at(-1)![0]).toBe('/v1/sites/S1/zones');
    expect(typeof api.post.mock.calls.at(-1)![2]).toBe('string');

    // CREATE SLOT
    const slotForm = formOf(container, translate('en', 'parking.addSlot'));
    fireEvent.change(slotForm.querySelector('input[name="code"]')!, { target: { value: 'P1' } });
    fireEvent.change(slotForm.querySelector('select[name="zone"]')!, { target: { value: 'Z1' } });
    fireEvent.change(slotForm.querySelector('select[name="type"]')!, { target: { value: 'standard' } });
    await act(async () => { fireEvent.click(byText(slotForm, translate('en', 'parking.addSlot'))[0]!); });
    expect(api.post.mock.calls.at(-1)![0]).toBe('/v1/slots?site=S1');
    expect(typeof api.post.mock.calls.at(-1)![2]).toBe('string');

    // DELETE SLOT P0 from its table row.
    const slotRow = rowWith(container, 'P0');
    await act(async () => { fireEvent.click(slotRow.querySelector('button.danger')!); });
    expect(api.del).toHaveBeenCalledWith('/v1/slots/P0?site=S1');
  });
});

describe('Super Admin cross-property boundary (criterion 7)', () => {
  it('a Super Admin can target a second property, load its entities, and WRITE a person into it', async () => {
    const { container } = mountPeople(['admin'], true);
    const propSelect = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === 'Other'))!;
    expect(propSelect).toBeTruthy(); // the property switch is offered to a Super Admin
    await act(async () => { fireEvent.change(propSelect, { target: { value: 'other' } }); });
    expect(paths.list).toContain('/v1/platform/tenants/other/units'); // switching loads THAT property's units

    // A representative write into the second property goes through the platform-scoped members endpoint, with a key.
    const form = formOf(container, translate('en', 'users.invite'));
    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: 'cross@other.mx' } });
    await act(async () => { fireEvent.click(byText(form, translate('en', 'users.invite'))[0]!); });
    const [path, body, key] = api.post.mock.calls.at(-1)!;
    expect(path).toBe('/v1/platform/tenants/other/members');
    expect((body as { email: string }).email).toBe('cross@other.mx');
    expect(typeof key).toBe('string');
  });

  it('a regular administrator never sees the property switch and issues no platform-scoped request', () => {
    const { container } = mountPeople(['admin'], false);
    const hasSwitch = [...container.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.textContent === 'Other'));
    expect(hasSwitch).toBe(false); // no cross-property control
    expect(paths.list).not.toContain('/v1/platform/tenants'); // and no platform-scoped fetch is issued
  });
});
