import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), get: api.get, post: api.post }));
const ctx = vi.hoisted(() => ({ useApp: vi.fn() }));
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp: ctx.useApp }));
const { EnforcementReports } = await import('../src/components/EnforcementReports.js');
const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: {}, zones: [] };
const report = {
  id: 'case1', site: 'DEMO-01', sessionId: 's1', plate: 'ABC123', region: 'MX', reasons: ['overstay'], action: 'fine',
  unit: { id: 'u1', code: 'A-101', name: 'Unit A' }, fine: { amountMinor: 500000, currency: 'MXN' },
  createdAt: '2026-10-20T14:00:00Z', fineIssuedAt: null, immobilizedAt: null,
  requiredActions: ['fine', 'immobilization'], status: 'open', evidence: [],
};
const btn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset();
  ctx.useApp.mockReturnValue({ site: SITE });
});
afterEach(() => cleanup());

describe('enforcement report actions', () => {
  it('requires fine and immobilization, issues the fine, and keeps evidence mandatory', async () => {
    api.get.mockResolvedValue({ items: [report] });
    api.post.mockResolvedValue({});
    const { container } = render(<I18nProvider defaultLocale="en" terminology={{}}><EnforcementReports status="open" /></I18nProvider>);
    await waitFor(() => expect(container.textContent).toContain('A-101'));
    expect(btn(container, translate('en', 'enf.immobilize')).hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('input[type=file]')?.hasAttribute('required')).toBe(true);
    await act(async () => { fireEvent.click(btn(container, translate('en', 'enf.issueFine', { amount: 'MX$5,000.00' }))); });
    expect(api.post).toHaveBeenCalledWith('/v1/enforcement/cases/case1/fine');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('keeps photo append available after all required actions are complete', async () => {
    api.get.mockResolvedValue({ items: [{ ...report, requiredActions: [], status: 'complete', fineIssuedAt: '2026-10-20T15:00:00Z', immobilizedAt: '2026-10-20T15:05:00Z' }] });
    const { container } = render(<I18nProvider defaultLocale="en" terminology={{}}><EnforcementReports status="all" /></I18nProvider>);
    await waitFor(() => expect(container.textContent).toContain('A-101'));
    expect(btn(container, translate('en', 'enf.addPhoto'))).toBeTruthy();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === translate('en', 'enf.immobilize'))).toBe(false);
  });
});
