import { act } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import type { Me, SiteInfo } from '../src/app-context.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const camera = vi.hoisted(() => ({ plate: 'ABC123', qr: 'TICKET1' }));
vi.mock('../src/components/LiveCamera.js', () => ({
  LiveCamera: ({ onPlate, onQr }: { onPlate: (p: { text: string; confidence: number; votes: number }) => void; onQr: (text: string) => void }) => (
    <>
      <button type="button" onClick={() => onPlate({ text: camera.plate, confidence: 0.98, votes: 3 })}>__camera_plate__</button>
      <button type="button" onClick={() => onQr(camera.qr)}>__camera_qr__</button>
    </>
  ),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../src/api.js', async (io) => ({ ...(await io()), get: api.get, post: api.post }));
const ctx = vi.hoisted(() => ({ useApp: vi.fn() }));
vi.mock('../src/app-context.js', async (io) => ({ ...(await io()), useApp: ctx.useApp }));

const { Enforcement } = await import('../src/screens/Enforcement.js');
const SITE: SiteInfo = { code: 'DEMO-01', name: 'Demo', timezone: 'America/Mexico_City', settings: {}, zones: [] };
const ME: Me = {
  roles: ['supervisor'], superadmin: false, user: null, unit: null,
  tenant: { slug: 'torre', name: 'Torre', country: 'MX', default_locale: 'en', locales: ['en'], currency: 'MXN', plate_regions: ['MX'], ai_mode: 'assist', terminology: {}, slot_types: [], retention_days: 365, training_export: false },
};
const base = {
  plate: 'ABC123', region: 'MX', sessionId: 's1', ticketCode: 'TICKET1', checkedInAt: '2026-10-20T14:00:00Z',
  currentSlot: 'B1-001', expectedSlot: 'B1-001', unit: null, fine: null,
};
const btn = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text)!;

function mount() {
  ctx.useApp.mockReturnValue({ me: ME, site: SITE });
  return render(<I18nProvider defaultLocale="en" terminology={{}}><Enforcement /></I18nProvider>);
}

afterEach(() => cleanup());
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

describe('supervisor enforcement capture and actions', () => {
  it('starts camera-first, swaps to the keypad, and shows a valid scan with its assigned box', async () => {
    api.get.mockResolvedValue({ ...base, status: 'valid', reasons: [], action: null });
    const { container } = mount();
    expect(container.querySelector('input[aria-label="Plate, ticket or guest pass"]')).toBeTruthy();
    expect(btn(container, '__camera_plate__')).toBeTruthy();
    await act(async () => { fireEvent.click(btn(container, '__camera_plate__')); });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/v1/enforcement/inspect?site=DEMO-01&entry=ABC123'));
    expect(container.textContent).toContain(translate('en', 'enf.valid'));
    expect(container.textContent).toContain('B1-001');
    await act(async () => { fireEvent.click(btn(container, translate('en', 'att.manualEntry'))); });
    expect(container.querySelector('.keypad')).toBeTruthy();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '__camera_plate__')).toBe(false);
  });

  it('submits a server-linked fine and shows the recorded department', async () => {
    const found = { ...base, status: 'invalid', reasons: ['overstay'], action: 'fine', unit: { id: 'u1', code: 'A-101', name: 'Unit A' }, fine: { amountMinor: 500000, currency: 'MXN' } };
    api.get.mockResolvedValue(found);
    api.post.mockResolvedValue({ ...found, id: 'case1', evidenceUrl: null });
    const { container } = mount();
    await act(async () => { fireEvent.click(btn(container, '__camera_qr__')); });
    await waitFor(() => expect(container.textContent).toContain(translate('en', 'enf.invalid')));
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes(translate('en', 'enf.flagFine', { amount: '' }).trim()) || b.textContent?.includes('fine'))!); });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/enforcement/flags', { site: 'DEMO-01', entry: 'TICKET1', action: 'fine' }));
    expect(container.textContent).toContain(translate('en', 'enf.fineRecorded', { unit: 'A-101' }));
  });

  it('offers optional photo evidence on an overstay fine', async () => {
    const found = { ...base, status: 'invalid', reasons: ['overstay'], action: 'fine', unit: { id: 'u1', code: 'A-101', name: 'Unit A' }, fine: { amountMinor: 500000, currency: 'MXN' } };
    api.get.mockResolvedValue(found);
    const { container } = mount();
    await act(async () => { fireEvent.click(btn(container, '__camera_qr__')); });
    await waitFor(() => expect(container.textContent).toContain(translate('en', 'enf.invalid')));
    const file = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(file).toBeTruthy();
    expect(file.required).toBe(false);
    const submit = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('fine')) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('requires photo evidence before an unlinked immobilization can be submitted', async () => {
    api.get.mockResolvedValue({ ...base, status: 'invalid', reasons: ['not_checked_in'], action: 'immobilization' });
    const { container } = mount();
    await act(async () => { fireEvent.click(btn(container, '__camera_qr__')); });
    await waitFor(() => expect(container.textContent).toContain(translate('en', 'enf.unlinked')));
    const file = container.querySelector('input[type=file]') as HTMLInputElement;
    const submit = btn(container, translate('en', 'enf.immobilize')) as HTMLButtonElement;
    expect(file.required).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });
});
