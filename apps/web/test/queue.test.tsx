import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.js';
import { Queue } from '../src/screens/Queue.js';
import { syncStore } from '../src/sync/storage.js';

// Mock the sync store
const mockListPending = vi.fn();
const mockRemove = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock('../src/sync/storage.js', () => ({
  syncStore: {
    listPending: () => mockListPending(),
    remove: (id: string) => mockRemove(id),
    updateStatus: (id: string, status: string, err?: string, nextAt?: string) => mockUpdateStatus(id, status, err, nextAt),
    migrateOldQueue: () => Promise.resolve(),
    getDevice: () => Promise.resolve({ deviceId: 'test-device', clientSeq: 1 }),
    saveDevice: () => Promise.resolve(),
  },
}));

vi.mock('../src/components/shared/ConfirmDialog.js', () => ({
  useConfirm: () => ({
    confirm: vi.fn(),
    close: vi.fn(),
    isOpen: false,
    options: {},
  }),
}));

vi.mock('../src/offline.js', () => ({
  changes: new EventTarget(),
  listQueue: () => Promise.resolve([]),
  listConflicts: () => Promise.resolve([]),
  retryConflict: vi.fn(),
  dismissConflict: vi.fn(),
  enqueue: vi.fn(),
  flush: vi.fn(),
}));

beforeEach(() => {
  mockListPending.mockResolvedValue([]);
  mockRemove.mockClear();
  mockUpdateStatus.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Queue', () => {
  it('renders without errors', async () => {
    // Mock a minimal tenant object for the app context
    const mockTenant = {
      id: 'test-tenant',
      slug: 'test',
      name: 'Test Tenant',
      settings: {},
    };

    // Mock useApp context
    vi.mock('../src/app-context.js', () => ({
      useApp: () => ({
        me: {
          tenant: mockTenant,
          roles: ['staff'],
          superadmin: false,
        },
        who: 'staff',
      }),
    }));

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <MemoryRouter initialEntries={['/t/test/queue']}>
          <Routes>
            <Route path="/t/:slug/queue" element={<Queue />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    // Wait for the component to render
    await waitFor(() => {
      // Check that the h1 element with "Sync queue" exists
      const h1 = document.querySelector('h1');
      expect(h1).not.toBeNull();
      expect(h1?.textContent).toBe('Sync queue');
    }, { timeout: 5000 });
  });
});
