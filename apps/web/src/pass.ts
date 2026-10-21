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

/** Where the current plate came from, so pass-derived values clear when the pass changes but a captured plate survives. */
export interface PlateProvenance { plate: string; plateFromPass: boolean }
/** A state patch for the check-in flow: the new plate, its provenance, and whether read metadata must be cleared too. */
export interface PlatePatch { plate: string; plateFromPass: boolean; clearRead: boolean }

/**
 * State patch when a pass is scanned or typed. A pass that carries a plate hint fills the plate (provenance = pass); a
 * pass with no hint clears a plate that came from a PREVIOUS pass but keeps a plate the attendant captured independently.
 */
export function passAcceptPatch(prev: PlateProvenance, q: PassQr | null): PlatePatch {
  const prefill = passPrefillPlate(q);
  if (prefill) return { plate: prefill, plateFromPass: true, clearRead: true };
  if (prev.plateFromPass) return { plate: '', plateFromPass: false, clearRead: true };
  return { plate: prev.plate, plateFromPass: false, clearRead: false };
}

/** State patch when a pass is removed: drop a plate that came from it, keep one the attendant captured independently. */
export function passRemovePatch(prev: PlateProvenance): PlatePatch {
  if (prev.plateFromPass) return { plate: '', plateFromPass: false, clearRead: true };
  return { plate: prev.plate, plateFromPass: false, clearRead: false };
}

/** What the browser can do, so Share can pick a path and report its outcome honestly. */
export interface ShareCaps { canShare: boolean; canShareFiles: boolean; canCopy: boolean }
/** The chosen share path, whether it copies text, and the status message key (empty while the share sheet handles it). */
export interface SharePlan { method: 'file' | 'text' | 'download'; copies: boolean; statusKey: 'res.shareCopied' | 'res.shareDownloaded' | '' }

/**
 * Pick a share path from the browser's capabilities. File-capable Web Share sends the QR image; text-only Web Share
 * sends the message (which carries the signed token, so the guest still has a redeemable pass); with no Web Share the
 * QR image is downloaded and the message copied only when the Clipboard API is actually available — never claimed otherwise.
 */
export function planPassShare(caps: ShareCaps): SharePlan {
  if (caps.canShare && caps.canShareFiles) return { method: 'file', copies: false, statusKey: '' };
  if (caps.canShare) return { method: 'text', copies: false, statusKey: '' };
  return caps.canCopy
    ? { method: 'download', copies: true, statusKey: 'res.shareCopied' }
    : { method: 'download', copies: false, statusKey: 'res.shareDownloaded' };
}

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

/**
 * Localized title + body a resident shares with their guest alongside the QR image. The signed pass token is appended
 * to the body so that even a text-only share leaves the guest with a redeemable pass (the attendant can scan or paste
 * it). Pure, so it is unit-testable.
 */
export function passShareMessage(
  t: (key: string, values?: Record<string, unknown>) => string,
  p: { guest: string; unit: string; property: string; code: string; expiresMinutes: number; token?: string },
): { title: string; text: string } {
  const body = t('res.shareBody', { guest: p.guest, unit: p.unit, property: p.property, code: p.code, minutes: p.expiresMinutes });
  return {
    title: t('res.shareTitle', { guest: p.guest }),
    text: p.token ? `${body}\n${p.token}` : body,
  };
}
