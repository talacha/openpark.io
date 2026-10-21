import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { decodeQr } from '../src/components/QrScanner.js';

/** Render a QR to RGBA pixels the way a camera frame would present it. */
function pixels(text: string, scale = 6, margin = 4, invert = false) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.floor(y / scale) - margin, c = Math.floor(x / scale) - margin;
    const dark = r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
    const v = dark !== invert ? 0 : 255;
    data.set([v, v, v, 255], (y * size + x) * 4);
  }
  return { data, width: size, height: size };
}

describe('decodeQr', () => {
  it('reads a guest-pass QR (a long token) exactly', () => {
    const token = 'OPP2|PyuMHp1KTH6KVQtvbx0skA|3|K7Q2M9XA|DEMO-01|A-101|Rosa%20Gu%C3%A9sped|ABC123|1792540800|AbCdEfGhIjKlMnOpQrStUv';
    expect(decodeQr(pixels(token))).toBe(token);
  });
  it('reads a short ticket code and an inverted (light-on-dark) code', () => {
    expect(decodeQr(pixels('W0RL3ZX3'))).toBe('W0RL3ZX3');
    expect(decodeQr(pixels('W0RL3ZX3', 6, 4, true))).toBe('W0RL3ZX3');
  });
  it('returns null when there is no QR in the frame', () => {
    const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
    expect(decodeQr(blank)).toBeNull();
  });
});
