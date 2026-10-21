import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.js';

/** Decode a QR code from camera pixels. Pure, so it can be tested without a camera. */
export function decodeQr(data: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): string | null {
  return jsQR(data.data as Uint8ClampedArray, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector } }

/** Camera viewfinder that calls `onResult` once with the first QR code it reads. */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | undefined; let raf = 0; let stopped = false; let last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    // The platform's own detector is faster and reads angled or small codes better; jsQR covers browsers without it.
    let native: Detector | null = null;
    try { native = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null; } catch { native = null; }
    let busy = false;
    const done = (text: string | null | undefined) => { if (text && !stopped) { stopped = true; onResult(text); } };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const v = video.current;
      if (stopped || busy || !v || v.readyState < 2 || !v.videoWidth || now - last < 120) return; // ~8 reads a second is plenty
      last = now;
      if (native) {
        busy = true;
        native.detect(v).then((r) => done(r[0]?.rawValue), () => { native = null; }).finally(() => { busy = false; });
        return;
      }
      // Cap the working size: decoding a 4K frame ten times a second only drains the battery.
      const k = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      canvas.width = Math.round(v.videoWidth * k); canvas.height = Math.round(v.videoHeight * k);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      done(decodeQr(ctx.getImageData(0, 0, canvas.width, canvas.height)));
    };

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then((s) => {
      stream = s;
      if (video.current) { video.current.srcObject = s; void video.current.play(); }
      raf = requestAnimationFrame(tick);
    }).catch(() => setError(t('att.cameraDenied')));

    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((x) => x.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <video ref={video} className="video" playsInline muted aria-label={t('att.scanning')} />
      <div className="muted" style={{ textAlign: 'center' }}>{error || t('att.scanning')}</div>
      <button type="button" className="btn" onClick={onClose}>{t('att.stopScan')}</button>
    </div>
  );
}
