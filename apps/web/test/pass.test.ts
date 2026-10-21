import { describe, expect, it } from 'vitest';
import { isPassExpired, parsePassQr, spaceCode } from '../src/pass.js';

const qr = 'OPP2|PyuMHp1KTH6KVQtvbx0skA|3|K7Q2M9XA|DEMO-01|A-101|Rosa%20Gu%C3%A9sped|ABC123|1792540800|AbCdEfGhIjKlMnOpQrStUv';

describe('guest pass QR', () => {
  it('carries every field needed to check a car in', () => {
    expect(parsePassQr(qr)).toEqual({ id: 'PyuMHp1KTH6KVQtvbx0skA', version: 3, code: 'K7Q2M9XA', site: 'DEMO-01', unit: 'A-101', guest: 'Rosa Guésped', plate: 'ABC123', expires: 1792540800 });
  });
  it('rejects anything that is not a v2 pass', () => {
    for (const bad of ['', 'W0RL3ZX3', 'OPP1.x.1.sig', qr.replace('OPP2', 'OPP9'), qr.split('|').slice(0, 9).join('|'), qr.replace('1792540800', 'soon')]) expect(parsePassQr(bad)).toBeNull();
  });
  it('knows when it has expired', () => {
    const q = parsePassQr(qr)!;
    expect(isPassExpired(q, 1792540799_000)).toBe(false);
    expect(isPassExpired(q, 1792540801_000)).toBe(true);
  });
  it('groups the code for reading aloud', () => expect(spaceCode('K7Q2M9XA')).toBe('K7Q2 M9XA'));
});
