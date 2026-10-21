import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import { SharePass } from '../src/screens/Resident.js';

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
