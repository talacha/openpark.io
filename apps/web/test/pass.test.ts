import { describe, expect, it } from 'vitest';
import { dataUrlToBlob, isPassExpired, parseGuestPassToken, parsePassQr, passAcceptPatch, passPrefillPlate, passRemovePatch, passShareMessage, passShareUrl, planPassShare, qrGifDataUrl, spaceCode } from '../src/pass.js';

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

describe('sharing a guest pass', () => {
  it('renders the QR as a GIF image data URL', () => {
    const url = qrGifDataUrl(qr);
    expect(url.startsWith('data:image/gif')).toBe(true);
    expect(url.length).toBeGreaterThan(100);
  });

  it('decodes a data URL into a Blob of the right type and non-zero size', () => {
    const blob = dataUrlToBlob(qrGifDataUrl(qr));
    expect(blob.type).toBe('image/gif');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('builds a share message that fills every placeholder from the pass', () => {
    const t = (_k: string, v?: Record<string, unknown>) => Object.entries(v ?? {}).map(([k, val]) => `${k}=${val}`).join('|');
    const { title, text } = passShareMessage(t, { guest: 'Rosa', unit: 'A-101', property: 'Torre Uno', code: 'K7Q2M9XA', expiresMinutes: 118 });
    expect(title).toContain('guest=Rosa');
    expect(text).toContain('guest=Rosa');
    expect(text).toContain('unit=A-101');
    expect(text).toContain('property=Torre Uno');
    expect(text).toContain('code=K7Q2M9XA');
    expect(text).toContain('minutes=118');
  });

  it('carries the signed token in the shared text so a text-only share is still redeemable', () => {
    const t = (k: string) => k; // the token rides alongside the localized body, not inside a placeholder
    const { text } = passShareMessage(t, { guest: 'Rosa', unit: 'A-101', property: 'Torre Uno', code: 'K7Q2M9XA', expiresMinutes: 60, token: qr });
    expect(text).toContain(qr);
    expect(parsePassQr(text.split('\n').pop()!)).not.toBeNull(); // the appended line is the full, parseable pass token
    // Without a token nothing is appended, so older callers keep the plain body.
    expect(passShareMessage(t, { guest: 'Rosa', unit: 'A-101', property: 'Torre Uno', code: 'K7Q2M9XA', expiresMinutes: 60 }).text).not.toContain('\n');
  });

  it('picks a share path and reports its outcome honestly for every browser capability', () => {
    // File-capable Web Share: the QR image goes through the share sheet, no local status needed.
    expect(planPassShare({ canShare: true, canShareFiles: true, canCopy: true })).toEqual({ method: 'file', copies: false, statusKey: '' });
    // Text-only Web Share: still shares the message (which carries the token); the share sheet reports success.
    expect(planPassShare({ canShare: true, canShareFiles: false, canCopy: true })).toEqual({ method: 'text', copies: false, statusKey: '' });
    // No Web Share but Clipboard present: download the QR and copy the message, and say so.
    expect(planPassShare({ canShare: false, canShareFiles: false, canCopy: true })).toEqual({ method: 'download', copies: true, statusKey: 'res.shareCopied' });
    // No Web Share and no Clipboard: only download — never claim a copy happened.
    expect(planPassShare({ canShare: false, canShareFiles: false, canCopy: false })).toEqual({ method: 'download', copies: false, statusKey: 'res.shareDownloaded' });
  });

  it('shares a guest link whose QR artifact round-trips back to the scanner/redeem token', () => {
    // A text-only share (no file support) still delivers something scannable: the guest opens this link, the page
    // renders the QR from the fragment, and the attendant camera reads back the exact redeemable pass token.
    const url = passShareUrl('https://park.example', qr);
    expect(url.startsWith('https://park.example/pass#t=')).toBe(true);
    const token = parseGuestPassToken(new URL(url).hash);
    expect(token).toBe(qr); // the fragment carries the full signed token, not a lossy subset
    expect(parsePassQr(token!)).not.toBeNull(); // and it parses as the pass the attendant redeems
    expect(passShareUrl('https://park.example/', qr)).toBe(url); // a trailing slash on origin is normalised
    expect(parseGuestPassToken('#nothing-here')).toBeNull();
  });

  it('prefills the plate only when the scanned pass carries a hint', () => {
    expect(passPrefillPlate(parsePassQr(qr))).toBe('ABC123');
    const noHint = qr.replace('ABC123', '');
    expect(passPrefillPlate(parsePassQr(noHint))).toBe('');
    expect(passPrefillPlate(null)).toBe('');
  });
});

describe('pass-derived plate provenance (no stale plate across passes)', () => {
  const hinted = parsePassQr(qr)!; // ABC123
  const noHint = parsePassQr(qr.replace('ABC123', ''))!;

  it('fills the plate from a hinted pass and marks it pass-derived', () => {
    expect(passAcceptPatch({ plate: '', plateFromPass: false }, hinted)).toEqual({ plate: 'ABC123', plateFromPass: true, clearRead: true });
  });

  it('clears a prior pass-derived plate when the next pass has no hint', () => {
    // scan pass A (ABC123) -> accept pass B (no hint): B must not inherit A's plate
    expect(passAcceptPatch({ plate: 'ABC123', plateFromPass: true }, noHint)).toEqual({ plate: '', plateFromPass: false, clearRead: true });
  });

  it('keeps a plate the attendant captured independently when a no-hint pass is accepted', () => {
    expect(passAcceptPatch({ plate: 'XYZ999', plateFromPass: false }, noHint)).toEqual({ plate: 'XYZ999', plateFromPass: false, clearRead: false });
  });

  it('drops the plate when a pass-derived pass is removed, but keeps a captured one', () => {
    expect(passRemovePatch({ plate: 'ABC123', plateFromPass: true })).toEqual({ plate: '', plateFromPass: false, clearRead: true });
    expect(passRemovePatch({ plate: 'XYZ999', plateFromPass: false })).toEqual({ plate: 'XYZ999', plateFromPass: false, clearRead: false });
  });
});
