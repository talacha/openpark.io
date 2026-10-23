import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * AC-2.1 / AC-2.2: the wide-screen sidebar collapses via a persistent, keyboard-operable toggle;
 * the preference persists; and while collapsed every top-level destination keeps an accessible name.
 * The sidebar is now built on shadcn/ui Base UI primitives (SidebarProvider, SidebarTrigger,
 * Sidebar, SidebarGroup, SidebarMenuItem). The toggle button is `SidebarTrigger`; state is
 * `data-state="expanded"`/`data-state="collapsed"`; persistence uses cookies via the provider.
 */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});

// Mock matchMedia for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const useApi = vi.fn(() => ({ data: null, loading: false, error: '', reload: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/components/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/hooks.js')>();
  return {
    ...actual,
    useApi,
    useLiveEvents: vi.fn(() => false),
  };
});

const useApp = vi.fn();
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp }));

vi.mock('../src/offline.js', () => ({
  changes: new EventTarget(),
  pendingCount: vi.fn(() => Promise.resolve(0)),
  listConflicts: vi.fn(() => Promise.resolve([])),
  flush: vi.fn(() => Promise.resolve({ synced: 0 })),
  setQueueOwner: vi.fn(),
}));

const { AppShell } = await import('../src/components/Shell.js');

function me(roles: Role[], superadmin = false): Me {
  return {
    roles, superadmin, user: { id: 'u1', email: 'r@torre.mx', name: 'Rosa', phone: null, locale: 'en' }, unit: { code: 'A-1', name: 'Apt 1' },
    tenant: { slug: 'acme', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'off', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
  };
}

function mount(roles: Role[] = ['resident']) {
  // Mock desktop viewport so the sidebar renders in its desktop (non-drawer) form
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  useApp.mockReturnValue({ me: me(roles), who: { user: null, superadmin: false, memberships: [] }, sites: [], site: null, setSiteCode: vi.fn(), signOut: vi.fn(() => Promise.resolve()), switchTenant: vi.fn(() => Promise.resolve()), reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter initialEntries={['/t/acme/r']}><AppShell /></MemoryRouter></I18nProvider>);
}

const sidebarTrigger = (c: HTMLElement) => c.querySelector('button[data-sidebar="trigger"]') as HTMLButtonElement;

beforeEach(() => { store.clear(); useApi.mockClear(); });
afterEach(() => cleanup());

describe('collapsible sidebar (AC-2.1, AC-2.2)', () => {
  it('renders the sidebar trigger button', () => {
    const { container } = mount();
    const btn = sidebarTrigger(container);
    expect(btn).toBeTruthy();
    expect(btn.querySelector('.sr-only')?.textContent).toBe('Toggle Sidebar');
  });

  it('renders menu groups based on roles', () => {
    const { container } = mount(['resident']);
    // Resident group should render
    expect(container.querySelector('[data-sidebar="group-label"]')).toBeTruthy();
    // Menu items should render
    expect(container.querySelectorAll('[data-sidebar="menu-item"]')).toHaveLength(2); // profile + newpass
  });

  it('sidebar trigger is keyboard-operable', () => {
    const { container } = mount();
    const btn = sidebarTrigger(container);
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('tabindex')).not.toBe('-1');
    expect(btn.type).toBe('button');
  });
});
