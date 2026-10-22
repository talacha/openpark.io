import { useEffect, useRef, useState } from 'react';
import { startLiveReading, type LivePlate } from '../alpr/live.js';
import type { Frame } from '../alpr/image.js';
import type { PlateRead } from '../alpr/reader.js';
import { useT } from '../i18n.js';
import { decodeQr } from './QrScanner.js';

type Status = 'starting' | 'loading' | 'ready' | 'unavailable';

/**
 * One live camera that watches for a QR code and a licence plate at the same time and submits the moment either is
 * valid: a QR is passed to `onQr`; a plate that the reader has seen in consecutive frames and that matches a known
 * format is passed to `onPlate`. Reading runs on-device (WebAssembly), so it works in a garage with no signal.
 * If the models are not installed the camera still reads QR codes and `onSnap` offers a still frame for server reading.
 */
export function LiveCamera({ qr = true, plate = true, regions = [], onQr, onPlate, onSnap, busy }: {
  qr?: boolean; plate?: boolean; regions?: string[]; busy?: boolean;
  onQr?: (text: string) => void; onPlate: (p: LivePlate) => void; onSnap?: (jpegBase64: string) => void;
}) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState('');
  const readerRef = useRef<{ read: (f: Frame) => Promise<PlateRead[]> } | null>(null);
  const cb = useRef({ onQr, onPlate });
  cb.current = { onQr, onPlate };

  useEffect(() => {
    let stream: MediaStream | undefined; let stop = () => {}; let gone = false;
    let lastQr = ''; let lastQrAt = 0;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) { setError(String(e)); setStatus('unavailable'); return; }
      if (gone) { stream.getTracks().forEach((x) => x.stop()); return; }
      const v = video.current!;
      v.srcObject = stream; await v.play().catch(() => undefined);

      setStatus(plate ? 'loading' : 'ready');
      if (plate) {
        import('../alpr/loader.js').then((m) => m.loadReader()).then((r) => { readerRef.current = r; if (!gone) setStatus('ready'); })
          .catch(() => { if (!gone) setStatus('unavailable'); });
      }

      stop = startLiveReading({
        video: v, intervalMs: 200, regions,
        read: async (frame) => {
          if (qr) {
            const text = decodeQr(frame);
            // The same code stays in view for a moment; report it once, but again if it is shown again later.
            if (text && (text !== lastQr || Date.now() - lastQrAt > 4000)) { lastQr = text; lastQrAt = Date.now(); cb.current.onQr?.(text); }
          }
          return plate && readerRef.current ? readerRef.current.read(frame) : [];
        },
        onPlate: (p) => cb.current.onPlate(p),
      });
    })();

    return () => { gone = true; stop(); stream?.getTracks().forEach((x) => x.stop()); };
  }, [qr, plate]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Capture now: read this frame immediately (no waiting for agreement between frames). */
  async function captureNow() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(v.videoWidth * k), height: Math.round(v.videoHeight * k) });
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    if (readerRef.current) {
      const reads = await readerRef.current.read(ctx.getImageData(0, 0, c.width, c.height));
      const top = reads.sort((a, b) => b.confidence - a.confidence)[0];
      if (top) { onPlate({ text: top.text, confidence: top.confidence, votes: 1 }); return; }
    }
    onSnap?.(c.toDataURL('image/jpeg', 0.85).split(',')[1]!);
  }

  return (
    <div className="stack">
      <video ref={video} className="video" playsInline muted aria-label={t('att.camera')} />
      <div className="muted" style={{ textAlign: 'center' }} role="status">
        {error ? t('att.cameraDenied') : status === 'loading' ? t('att.readerLoading') : status === 'unavailable' ? t('att.readerOff') : t(qr && plate ? 'att.readerReady' : plate ? 'att.readerPlate' : 'att.scanning')}
      </div>
      {plate && <button type="button" className="btn primary big" disabled={busy || !!error || status === 'starting' || (status === 'loading')} onClick={() => void captureNow()}>{busy ? t('common.loading') : t('att.capture')}</button>}
    </div>
  );
}
