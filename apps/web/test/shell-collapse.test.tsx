import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, Role } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * AC-2.1 / AC-2.2: the wide-screen sidebar collapses via a persistent, keyboard-operable toggle that carries
 * aria-expanded; the preference persists to localStorage 'op.menu.collapsed'; and while collapsed every top-level
 * destination keeps an accessible name (aria-label) and a visible tooltip (title) even though its text is hidden.
 */
// jsdom in this project does not expose a working localStorage; back it with a Map so the persistence contract is exercised.
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

// SyncBadge's offline queue uses indexedDB, which jsdom lacks; stub the queue so its mount effect is inert.
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
  useApp.mockReturnValue({ me: me(roles), who: { user: null, superadmin: false, memberships: [] }, sites: [], site: null, setSiteCode: vi.fn(), signOut: vi.fn(() => Promise.resolve()), switchTenant: vi.fn(() => Promise.resolve()), reload: vi.fn(() => Promise.resolve()) });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><MemoryRouter initialEntries={['/t/acme/r']}><AppShell /></MemoryRouter></I18nProvider>);
}

const collapseBtn = (c: HTMLElement) => c.querySelector('button.menu-collapse') as HTMLButtonElement;

beforeEach(() => { store.clear(); useApi.mockClear(); });
afterEach(() => cleanup());

describe('collapsible sidebar (AC-2.1, AC-2.2)', () => {
  it('starts expanded and the toggle exposes aria-expanded + aria-controls', () => {
    const { container } = mount();
    const shell = container.querySelector('.shell') as HTMLElement;
    expect(shell.getAttribute('data-collapsed')).toBe('false');
    const btn = collapseBtn(container);
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-controls')).toBe('app-menu');
    expect(btn.getAttribute('aria-expanded')).toBe('true'); // expanded now
    expect(btn.getAttribute('aria-label')).toBe(translate('en', 'nav.collapse'));
  });

  it('flips data-collapsed, updates aria-expanded, and persists to localStorage on toggle', () => {
    const { container } = mount();
    const shell = container.querySelector('.shell') as HTMLElement;
    act(() => { fireEvent.click(collapseBtn(container)); });
    expect(shell.getAttribute('data-collapsed')).toBe('true');
    expect(collapseBtn(container).getAttribute('aria-expanded')).toBe('false');
    expect(collapseBtn(container).getAttribute('aria-label')).toBe(translate('en', 'nav.expand'));
    expect(localStorage.getItem('op.menu.collapsed')).toBe('1');
    act(() => { fireEvent.click(collapseBtn(container)); });
    expect(shell.getAttribute('data-collapsed')).toBe('false');
    expect(localStorage.getItem('op.menu.collapsed')).toBe('0');
  });

  it('restores the collapsed preference from localStorage on mount', () => {
    try { localStorage.setItem('op.menu.collapsed', '1'); } catch { /* ignore */ }
    const { container } = mount();
    expect((container.querySelector('.shell') as HTMLElement).getAttribute('data-collapsed')).toBe('true');
  });

  it('keeps accessible names and tooltips on collapsed top-level destinations', () => {
    try { localStorage.setItem('op.menu.collapsed', '1'); } catch { /* ignore */ }
    const { container } = mount(['resident']);
    // The Resident group renders as a head button even when collapsed.
    const head = container.querySelector('.menu-group[data-group="resident"] .menu-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-label')).toBe(translate('en', 'nav.resident'));
    expect(head.getAttribute('title')).toBe(translate('en', 'nav.resident'));
    expect(head.querySelector('svg.menu-icon')).toBeTruthy(); // an icon stands in for the hidden label
    expect(head.querySelector('.menu-label')?.textContent).toBe(translate('en', 'nav.resident')); // label kept in the DOM, only visually hidden
  });

  it('clicking a collapsed group expands the whole sidebar and opens that group', () => {
    try { localStorage.setItem('op.menu.collapsed', '1'); } catch { /* ignore */ }
    const { container } = mount(['resident']);
    const shell = container.querySelector('.shell') as HTMLElement;
    expect(shell.getAttribute('data-collapsed')).toBe('true');
    act(() => { fireEvent.click(container.querySelector('.menu-group[data-group="resident"] .menu-head') as HTMLButtonElement); });
    expect(shell.getAttribute('data-collapsed')).toBe('false'); // expanded by the click
    const head = container.querySelector('.menu-group[data-group="resident"] .menu-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('true'); // the group is now open
  });

  it('keeps mobile drawer groups independent of the stored desktop collapse preference', async () => {
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      localStorage.setItem('op.menu.collapsed', '1');
      const { container } = mount(['admin']);
      await act(async () => { fireEvent.click(container.querySelector('[data-sidebar="trigger"]') as HTMLButtonElement); });
      const drawer = document.querySelector('[data-mobile="true"]') as HTMLElement;
      expect(drawer).toBeTruthy();
      expect(drawer.id).toBe('app-menu');
      expect(drawer.querySelector('.menu-collapse')).toBeNull();
      const head = drawer.querySelector('.menu-group[data-group="admin"] .menu-head') as HTMLButtonElement;
      await act(async () => { fireEvent.click(head); });
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect((container.querySelector('.shell') as HTMLElement).getAttribute('data-collapsed')).toBe('true');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});
