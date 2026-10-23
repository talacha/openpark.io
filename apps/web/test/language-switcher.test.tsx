import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, NAMES, SELECTABLE_LOCALES, foldToSurface, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});

const useApi = vi.fn(() => ({ data: null, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/components/hooks.js', async (io) => ({ ...(await io()), useApi, useLiveEvents: vi.fn(() => false) }));
const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));
vi.mock('../src/offline.js', () => ({
  changes: new EventTarget(), pendingCount: vi.fn(() => Promise.resolve(0)), listConflicts: vi.fn(() => Promise.resolve([])),
  flush: vi.fn(() => Promise.resolve({ synced: 0 })), setQueueOwner: vi.fn(),
}));

const { AppMenu } = await import('../src/components/AppMenu.js');
const { SidebarProvider } = await import('../src/components/ui/sidebar.js');
const { TooltipProvider } = await import('../src/components/ui/tooltip.js');

function me(roles: Role[] = ['admin']): Me {
  return {
    roles, superadmin: false, user: { id: 'u1', email: 'a@torre.mx', name: 'Ada', phone: null, locale: 'en' }, unit: null,
    tenant: { slug: 'acme', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false, address: null, notes: null },
  };
}

function mount(defaultLocale = 'en') {
  useApp.mockReturnValue({ me: me(), who: { user: null, superadmin: false, memberships: [] }, sites: [], site: null, setSiteCode: vi.fn(), signOut: vi.fn(() => Promise.resolve()), switchTenant: vi.fn(() => Promise.resolve()), reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale={defaultLocale} terminology={{}}><MemoryRouter initialEntries={['/t/acme/users']}><TooltipProvider><SidebarProvider><AppMenu /></SidebarProvider></TooltipProvider></MemoryRouter></I18nProvider>);
}

afterEach(() => { cleanup(); store.clear(); });

describe('language switcher (AC-5.4: es-MX + en only)', () => {
  it('lists exactly Spanish (Mexico) and English, nothing else', () => {
    const { container } = mount();
    const select = container.querySelector(`select[aria-label="${translate('en', 'auth.language')}"]`) as HTMLSelectElement;
    expect(select).toBeTruthy();
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual([...SELECTABLE_LOCALES]);
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(SELECTABLE_LOCALES.map((l) => NAMES[l]));
    // en-XA (pseudo) and the dormant catalogs never appear in the switcher.
    expect(values).not.toContain('en-XA');
    expect(values).not.toContain('es-ES');
  });

  it('folds a stored es-ES preference to es-MX without error and selects es-MX in the switcher', () => {
    store.set('op.locale', 'es-ES');
    expect(foldToSurface('es-ES')).toBe('es-MX');
    const { container } = mount('es-ES');
    const select = container.querySelector(`select[aria-label="${translate('es-MX', 'auth.language')}"]`) as HTMLSelectElement;
    expect(select.value).toBe('es-MX');
  });
});
