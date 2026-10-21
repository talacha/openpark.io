import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import { SharePass } from '../src/screens/Resident.js';
import { passShareUrl } from '../src/pass.js';

// Render React 18 trees under act() without warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const qr = 'OPP2|PyuMHp1KTH6KVQtvbx0skA|3|K7Q2M9XA|DEMO-01|A-101|Rosa%20Gu%C3%A9sped|ABC123|1792540800|AbCdEfGhIjKlMnOpQrStUv';

/** The no-Web-Share desktop path exercised here: the QR download is the real share artifact and must always happen. */
function setNavigator(opts: { clipboard?: 'ok' | 'reject' | 'absent' }) {
  // No Web Share API -> planPassShare picks the download path.
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  if (opts.clipboard === 'absent') {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  } else {
    const writeText = opts.clipboard === 'reject'
      ? vi.fn(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })))
      : vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }
}

let container: HTMLDivElement;
let root: Root;
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clickSpy.mockRestore();
});

async function renderAndShare() {
  await act(async () => {
    root.render(
      <I18nProvider defaultLocale="en" terminology={{}}>
        <SharePass qr={qr} guest="Rosa" property="Torre Uno" unit="A-101" code="K7Q2M9XA" expiresMinutes={118} />
      </I18nProvider>,
    );
  });
  const button = container.querySelector('button')!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0)); // let the async share() settle its clipboard + download steps
  });
  return container.querySelector('[role="status"]')!.textContent;
}

describe('SharePass download path (no Web Share API)', () => {
  it('still downloads the QR when the Clipboard API rejects, and reports download-only honestly', async () => {
    // Regression: the clipboard write used to gate the download, so a rejecting-but-present Clipboard left the resident
    // with nothing to send. The download must proceed regardless, and the status must not claim a copy happened.
    setNavigator({ clipboard: 'reject' });
    const status = await renderAndShare();
    expect(clickSpy).toHaveBeenCalledTimes(1); // the QR was downloaded despite the clipboard failure
    expect(status).toBe(translate('en', 'res.shareDownloaded'));
    expect(status).not.toBe(translate('en', 'res.shareFailed'));
  });

  it('downloads and reports a copy when the Clipboard API succeeds', async () => {
    setNavigator({ clipboard: 'ok' });
    const status = await renderAndShare();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(status).toBe(translate('en', 'res.shareCopied'));
  });

  it('downloads only (no copy claim) when there is no Clipboard API', async () => {
    setNavigator({ clipboard: 'absent' });
    const status = await renderAndShare();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(status).toBe(translate('en', 'res.shareDownloaded'));
  });
});

/**
 * The Web Share path (phones, the primary target). The reviewer noted neither navigator.share branch was executed, so
 * these mount SharePass, click Share, and assert the payload the guest actually receives — crucially that it carries
 * the public guest-link fragment URL and the signed token, so a text-only share still delivers a scannable pass.
 */
interface ShareArg { title?: string; text?: string; url?: string; files?: File[] }
function setWebShare(opts: { files: boolean; outcome: 'ok' | 'cancel' | 'fail' }) {
  const err = opts.outcome === 'cancel'
    ? Object.assign(new Error('dismissed'), { name: 'AbortError' })
    : new Error('share failed');
  const share = vi.fn((_d: ShareArg) => (opts.outcome === 'ok' ? Promise.resolve() : Promise.reject(err)));
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: opts.files ? vi.fn(() => true) : undefined });
  // A Clipboard is present but must be IGNORED on the Web Share path — only the download fallback copies.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => Promise.resolve()) } });
  return share;
}

describe('SharePass Web Share path', () => {
  it('shares the QR image file plus the guest link + token when the browser can share files', async () => {
    const share = setWebShare({ files: true, outcome: 'ok' });
    const status = await renderAndShare();
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0]![0] as ShareArg;
    expect(arg.url).toBe(passShareUrl(location.origin, qr)); // the guest opens this to render a scannable QR
    expect(arg.files).toHaveLength(1);
    expect(arg.text).toContain(qr); // the signed token rides along as a redeemable fallback
    expect(clickSpy).not.toHaveBeenCalled(); // the OS sheet handled it; no download fallback fired
    expect(status).toBe(''); // the share sheet owns the outcome, so no status is claimed
  });

  it('falls back to a text + link share (no file) when files are unsupported', async () => {
    const share = setWebShare({ files: false, outcome: 'ok' });
    await renderAndShare();
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0]![0] as ShareArg;
    expect(arg.files).toBeUndefined();
    expect(arg.url).toBe(passShareUrl(location.origin, qr));
    expect(arg.text).toContain(qr);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('treats a dismissed share sheet as a non-error (no failure message)', async () => {
    setWebShare({ files: true, outcome: 'cancel' });
    const status = await renderAndShare();
    expect(status).toBe(''); // AbortError = the resident closed the sheet, not a failure
  });

  it('reports a genuine share failure honestly', async () => {
    setWebShare({ files: true, outcome: 'fail' });
    const status = await renderAndShare();
    expect(status).toBe(translate('en', 'res.shareFailed'));
  });
});
