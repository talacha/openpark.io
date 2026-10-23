import jsQR from 'jsqr';

/** Decode a QR code from camera pixels. Pure, so it can be tested without a camera. */
export function decodeQr(data: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): string | null {
  return jsQR(data.data as Uint8ClampedArray, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}
