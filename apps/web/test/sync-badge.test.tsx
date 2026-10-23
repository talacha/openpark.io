import { act } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.js';
import type { Me } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ request: vi.fn(), accessToken: vi.fn() }));
const queue = vi.hoisted(() => ({ flush: vi.fn(), pendingCount: vi.fn(), listConflicts: vi.fn() }));
const ctx = vi.hoisted(() => ({ useApp: vi.fn() }));

vi.mock('../src/api.js', async (io) => ({ ...(await io()), request: api.request, accessToken: api.accessToken }));
vi.mock('../src/offline.js', async (io) => ({
  ...(await io()),
  flush: queue.flush,
  pendingCount: queue.pendingCount,
  listConflicts: queue.listConflicts,
}));
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp: ctx.useApp }));

const { SyncBadge } = await import('../src/components/SyncBadge.js');

const me: Me = {
  roles: ['attendant'],
  user: { id: 'user-1', email: 'a@example.com', name: 'Attendant', phone: null, locale: 'en' },
  unit: null,
  superadmin: false,
  tenant: { slug: 'demo', name: 'Demo', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'assist', terminology: {}, slot_types: [], retention_days: 365, training_export: false, address: null, notes: null },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('offline queue reconnect trigger', () => {
  it('checks connectivity and replays the signed-in user queue when the browser comes online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    api.request.mockResolvedValue({});
    api.accessToken.mockResolvedValue('current-token');
    queue.pendingCount.mockResolvedValue(1);
    queue.listConflicts.mockResolvedValue([]);
    queue.flush.mockResolvedValue({ synced: 1, conflicts: 0 });
    ctx.useApp.mockReturnValue({ me });

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <MemoryRouter><SyncBadge /></MemoryRouter>
      </I18nProvider>,
    );
    expect(queue.flush).not.toHaveBeenCalled();

    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(api.request).toHaveBeenCalledWith('GET', '/healthz'));
    await waitFor(() => expect(queue.flush).toHaveBeenCalledWith(expect.any(Function), 'user-1'));
    await waitFor(() => expect(queue.flush).toHaveBeenCalledTimes(1));
  });
});
