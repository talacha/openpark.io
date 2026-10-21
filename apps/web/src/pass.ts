import qrcode from 'qrcode-generator';

/** What a guest-pass QR carries. Read client-side for instant feedback and to pre-fill check-in; the server re-verifies everything. */
export interface PassQr { id: string; version: number; code: string; site: string; unit: string; guest: string; plate: string; expires: number }

/** `OPP2|<id>|<version>|<code>|<site>|<unit>|<guest>|<plate hint>|<expiry epoch>|<signature>`; null for anything else. */
export function parsePassQr(text: string): PassQr | null {
  const p = text.trim().split('|');
  if (p.length !== 10 || p[0] !== 'OPP2') return null;
  try {
    const expires = Number(p[8]);
    if (!Number.isFinite(expires)) return null;
    return { id: p[1]!, version: Number(p[2]), code: p[3]!, site: decodeURIComponent(p[4]!), unit: decodeURIComponent(p[5]!), guest: decodeURIComponent(p[6]!), plate: decodeURIComponent(p[7]!), expires };
  } catch { return null; }
}

export const isPassExpired = (q: PassQr, now = Date.now()) => q.expires * (q.expires < 1e12 ? 1000 : 1) <= now;

/** Group the 8-character code for reading aloud: K7Q2 M9XA. */
export const spaceCode = (c: string) => c.replace(/(.{4})(?=.)/g, '$1 ');

/** The plate a scanned pass suggests, if any — used to pre-fill the attendant check-in form. */
export const passPrefillPlate = (q: PassQr | null): string => q?.plate?.trim() ?? '';

/**
 * The QR as a shareable GIF image data URL. `qrcode-generator` renders a pure data URL with no canvas, so this
 * works in the browser and in jsdom tests. Error correction M, matching the on-screen pass QR.
 */
export function qrGifDataUrl(value: string, cellSize = 6, margin = 4): string {
  const q = qrcode(0, 'M');
  q.addData(value, 'Byte');
  q.make();
  return q.createDataURL(cellSize, margin);
}

/** Decode a `data:<mime>;base64,<data>` URL into a Blob, so a QR image can be shared or downloaded. */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(',');
  const header = url.slice(0, comma);
  const mime = header.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Localized title + body a resident shares with their guest alongside the QR image. Pure, so it is unit-testable. */
export function passShareMessage(
  t: (key: string, values?: Record<string, unknown>) => string,
  p: { guest: string; unit: string; property: string; code: string; expiresMinutes: number },
): { title: string; text: string } {
  return {
    title: t('res.shareTitle', { guest: p.guest }),
    text: t('res.shareBody', { guest: p.guest, unit: p.unit, property: p.property, code: p.code, minutes: p.expiresMinutes }),
  };
}
