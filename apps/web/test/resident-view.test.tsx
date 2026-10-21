import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';
import type { PassView } from '../src/screens/Resident.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});

// Drive the two useApi calls: /v1/passes/active (first) and /v1/passes?limit=10 (second).
let activeData: unknown = null;
let historyData: unknown = null;
const reload = vi.fn(() => Promise.resolve());
const useApi = vi.fn((path: string | null) => ({ data: path?.includes('active') ? activeData : historyData, loading: false, error: '', reload }));
vi.mock('../src/components/hooks.js', async (io) => ({ ...(await io()), useApi }));

const patch = vi.fn(() => Promise.resolve({ ok: true }));
const post = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), patch, post }));

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

const { ResidentHome } = await import('../src/screens/Resident.js');

const policy = { qrTtlMin: 120, maxStayHours: 12, overstayCharge: 500000, currency: 'MXN' };

function makeMe(over: Partial<Me> = {}): Me {
  return {
    roles: ['resident'] as Role[], superadmin: false,
    user: { id: 'u1', email: 'rosa.residente@torre.mx', name: null, phone: null, locale: 'en' },
    unit: { code: 'A-101', name: 'Apt 101' }, avatarUrl: null,
    tenant: { slug: 'acme', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
    ...over,
  };
}

/**
 * The screen reads `?edit=1` from the router (useSearchParams) and `#new` from the real window location (location.hash),
 * mirroring how the deep-links in the sidebar deliver them. `search` drives the router entry; `hash` the window.
 */
function mount(me: Me, { search = '', hash = '' }: { search?: string; hash?: string } = {}) {
  window.location.hash = hash;
  useApp.mockReturnValue({ me, reload });
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}>
      <MemoryRouter initialEntries={[`/t/acme/r${search}`]}><ResidentHome /></MemoryRouter>
    </I18nProvider>,
  );
}

const en = (k: string, v?: Record<string, unknown>) => translate('en', k, v);

beforeEach(() => { store.clear(); activeData = { pass: null, policy }; historyData = []; reload.mockClear(); patch.mockClear(); post.mockClear(); });
afterEach(() => { cleanup(); window.location.hash = ''; });

describe('Resident view (AC-3.1 … 3.8)', () => {
  it('shows avatar initials fallback, a bottom-center unit pill, and welcomes by name when present', () => {
    const { container } = mount(makeMe({ user: { id: 'u1', email: 'rosa.residente@torre.mx', name: 'Rosa Residente', locale: 'en', phone: null } }));
    expect(container.querySelector('.avatar-initials')?.textContent).toBe('RR'); // two name words → RR
    const pill = container.querySelector('.avatar-pill') as HTMLElement;
    expect(pill.textContent).toBe('A-101');
    expect(container.querySelector('h1')?.textContent).toBe(en('res.welcomeName', { name: 'Rosa Residente' }));
  });

  it('falls back to the email local-part initials when there is no name', () => {
    const { container } = mount(makeMe());
    expect(container.querySelector('.avatar-initials')?.textContent).toBe('RR'); // rosa.residente → R, R
  });

  it('starts with both pass sections collapsed by default', () => {
    const { container } = mount(makeMe());
    const heads = [...container.querySelectorAll('.collapsible-head')] as HTMLButtonElement[];
    expect(heads).toHaveLength(2);
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(container.querySelector('form')).toBeNull(); // the create form lives inside the collapsed New section
  });

  it('opens the editor from the pencil button and submits name + phone + notify opt-in', async () => {
    const { container, getByLabelText } = mount(makeMe());
    const pencil = container.querySelector('button[aria-label="' + en('res.editProfile') + '"]') as HTMLButtonElement;
    act(() => fireEvent.click(pencil));
    const name = getByLabelText(en('auth.name')) as HTMLInputElement;
    act(() => fireEvent.change(name, { target: { value: 'Nueva Rosa' } }));
    const form = container.querySelector('form')!;
    await act(async () => { fireEvent.submit(form); await Promise.resolve(); });
    expect(patch).toHaveBeenCalledWith('/v1/me/profile', expect.objectContaining({ name: 'Nueva Rosa', notifyGuestEvents: true }));
  });

  it('?edit=1 opens the profile editor (wins over #new) and leaves the pass sections collapsed', () => {
    const { container } = mount(makeMe(), { search: '?edit=1', hash: '#new' });
    expect(container.querySelector('input[name="name"]')).toBeTruthy(); // editor is open
    const heads = [...container.querySelectorAll('.collapsible-head')] as HTMLButtonElement[];
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  });

  it('labels pass history rows by issuer without exposing staff identity', () => {
    historyData = [
      { id: 'p1', status: 'completed', displayStatus: 'completed', unit: { code: 'A-101', name: 'Apt 101' }, guestName: 'Luis', guestPhone: null, guestEmail: null, plateHint: null, expiresAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', checkedInAt: null, completedAt: null, cancelledAt: null, overstayCharge: null, qr: null, issuedByRole: 'staff' },
      { id: 'p2', status: 'completed', displayStatus: 'completed', unit: { code: 'A-101', name: 'Apt 101' }, guestName: 'Ana', guestPhone: null, guestEmail: null, plateHint: null, expiresAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', checkedInAt: null, completedAt: null, cancelledAt: null, overstayCharge: null, qr: null, issuedByRole: 'host' },
      { id: 'p3', status: 'completed', displayStatus: 'completed', unit: { code: 'A-101', name: 'Apt 101' }, guestName: 'Leo', guestPhone: null, guestEmail: null, plateHint: null, expiresAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', checkedInAt: null, completedAt: null, cancelledAt: null, overstayCharge: null, qr: null } as PassView, // legacy, no issuedByRole
    ];
    const { container } = mount(makeMe());
    // Open the Previous section.
    const prevHead = [...container.querySelectorAll('.collapsible-head')][1] as HTMLButtonElement;
    act(() => fireEvent.click(prevHead));
    const text = container.textContent ?? '';
    expect(text).toContain(en('res.issuedBy_staff'));
    expect(text).toContain(en('res.issuedBy_host'));
    expect(text).toContain(en('res.issuedBy_unknown')); // legacy NULL labelled neutrally
  });

  it('shows the pending-verification banner (and hides the form) only for a resident with an unverified unit', () => {
    const { container } = mount(makeMe({ unitVerified: false }), { hash: '#new' });
    expect(container.textContent).toContain(en('res.pendingVerify'));
    expect(container.querySelector('form')).toBeNull(); // the create form is hidden while pending
  });

  it('renders the create form (not the banner) when the unit is verified', () => {
    const { container } = mount(makeMe({ unitVerified: true }), { hash: '#new' });
    expect(container.textContent).not.toContain(en('res.pendingVerify'));
    expect(container.querySelector('input[name="guestName"]')).toBeTruthy();
  });

  it('treats a missing unitVerified as verified so the screen builds before FEAT-005', () => {
    const me = makeMe();
    delete (me as { unitVerified?: boolean }).unitVerified;
    const { container } = mount(me, { hash: '#new' });
    expect(container.textContent).not.toContain(en('res.pendingVerify'));
    expect(container.querySelector('input[name="guestName"]')).toBeTruthy();
  });

  it('renders the overstay note from the configured policy amount (never a literal)', () => {
    const { container } = mount(makeMe(), { hash: '#new' });
    // The amount is currency-formatted from the policy value (500000 minor MXN units), never a literal.
    const amount = new Intl.NumberFormat('en', { style: 'currency', currency: 'MXN' }).format(5000);
    expect(amount).toContain('5,000');
    expect(container.textContent).toContain(en('res.rules', { hours: 12, amount }));
  });
});
