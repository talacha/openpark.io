import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.js';
import { ConnectionStatus } from '../src/components/ConnectionStatus.js';
import * as useSyncModule from '../src/sync/useSync.js';

// Mock modules at the top level
vi.mock('../src/sync/storage.js', () => ({
  syncStore: {
    listPending: () => Promise.resolve([]),
  },
}));

vi.mock('../src/sync/useSync.js', () => ({
  useSync: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

describe('ConnectionStatus', () => {
  it('renders Online state', () => {
    vi.mocked(useSyncModule.useSync).mockReturnValue({ status: 'online', pending: 0, conflicts: 0, failed: 0, lastSync: null });

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <ConnectionStatus />
      </I18nProvider>,
    );

    expect(document.body.innerHTML).toContain('sync.statusOnline');
  });

  it('renders Offline state', () => {
    vi.mocked(useSyncModule.useSync).mockReturnValue({ status: 'offline', pending: 0, conflicts: 0, failed: 0, lastSync: null });

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <ConnectionStatus />
      </I18nProvider>,
    );

    expect(document.body.innerHTML).toContain('sync.statusOffline');
  });

  it('renders Syncing state with count', () => {
    vi.mocked(useSyncModule.useSync).mockReturnValue({ status: 'syncing', pending: 3, conflicts: 0, failed: 0, lastSync: null });

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <ConnectionStatus />
      </I18nProvider>,
    );

    expect(document.body.innerHTML).toContain('sync.statusSyncing');
  });

  it('renders Needs attention state', () => {
    vi.mocked(useSyncModule.useSync).mockReturnValue({ status: 'attention', pending: 0, conflicts: 2, failed: 1, lastSync: null });

    render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <ConnectionStatus />
      </I18nProvider>,
    );

    expect(document.body.innerHTML).toContain('sync.statusNeedsAttention');
  });
});
