import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, translate } from '../src/i18n.js';
import { GuestPass } from '../src/screens/GuestPass.js';
import { passShareUrl } from '../src/pass.js';

// Render React 18 trees under act() without warnings (Testing Library sets this too, but be explicit).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The public, unauthenticated guest page is the OTHER half of criterion 1: once a resident shares the link, the guest
 * opens `/pass#t=…` with no session and must see a scannable QR rendered client-side. These tests mount the real
 * screen, drive it through the exact shared URL fragment the SharePass button emits, and assert the rendered artifact.
 */
function mountAt(token: string | null) {
  // The screen reads the token from the URL fragment on mount, exactly as the shared link delivers it.
  window.location.hash = token === null ? '' : new URL(passShareUrl('http://localhost', token)).hash;
  return render(
    <I18nProvider defaultLocale="en" terminology={{}}>
      <GuestPass />
    </I18nProvider>,
  );
}

const LIVE = 'OPP2|abc|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|4102444800|SIGSIGSIG'; // expires in 2100 → still valid
const EXPIRED = 'OPP2|abc|3|K7Q2M9XA|DEMO-01|A-101|Rosa|ABC123|1000|SIGSIGSIG'; // expiry in 1970 → expired

afterEach(() => { cleanup(); window.location.hash = ''; });

describe('GuestPass public page renders the shared pass from the URL fragment', () => {
  it('renders a scannable QR, the guest/unit line and the verification code for a live pass', () => {
    const { container } = mountAt(LIVE);
    // The QR is rendered on the guest device (role="img" carries the guest name as its accessible label).
    const qr = container.querySelector('[role="img"]')!;
    expect(qr).not.toBeNull();
    expect(qr.getAttribute('aria-label')).toBe('Rosa');
    expect(qr.querySelector('svg')).not.toBeNull(); // the token was actually encoded to an SVG QR
    const text = container.textContent ?? '';
    expect(text).toContain(translate('en', 'guest.for', { guest: 'Rosa', unit: 'A-101' }));
    expect(text).toContain('K7Q2 M9XA'); // spaced verification code, so the attendant can read it aloud
    expect(text).not.toContain(translate('en', 'res.expired'));
  });

  it('shows the expired notice and no QR once the pass has lapsed', () => {
    const { container } = mountAt(EXPIRED);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.textContent ?? '').toContain(translate('en', 'res.expired'));
  });

  it('shows an invalid-link notice when the fragment is missing or malformed', () => {
    const bad = mountAt('not-a-pass-token');
    expect(bad.container.textContent ?? '').toContain(translate('en', 'guest.invalid'));
    cleanup();
    const none = mountAt(null);
    expect(none.container.textContent ?? '').toContain(translate('en', 'guest.invalid'));
  });
});
