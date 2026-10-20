import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.js';

/** Decode a QR code from camera pixels. Pure, so it can be tested without a camera. */
export function decodeQr(data: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  return jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** Camera viewfinder that calls `onResult` once with the first QR code it reads. */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | undefined; let raf = 0; let stopped = false; let last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const v = video.current;
      if (stopped || !v || v.readyState < 2 || now - last < 100) return; // ~10 reads a second is plenty
      last = now;
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      ctx.drawImage(v, 0, 0);
      const text = decodeQr(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (text) { stopped = true; onResult(text); }
    };

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
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
