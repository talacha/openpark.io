import { useEffect, useRef, useState } from 'react';
import { startLiveReading, type LivePlate } from '../alpr/live.js';
import type { Frame } from '../alpr/image.js';
import type { PlateRead } from '../alpr/reader.js';
import { useT } from '../i18n.js';
import { decodeQr } from './QrScanner.js';
import { Button } from './ui/button.js';

type Status = 'starting' | 'loading' | 'ready' | 'unavailable';

/** Reads QR codes and plates on-device, with a still-frame fallback for server reading. */
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
      if (gone) { stream.getTracks().forEach((track) => track.stop()); return; }
      const element = video.current!;
      element.srcObject = stream; await element.play().catch(() => undefined);

      setStatus(plate ? 'loading' : 'ready');
      if (plate) {
        import('../alpr/loader.js').then((module) => module.loadReader()).then((reader) => { readerRef.current = reader; if (!gone) setStatus('ready'); })
          .catch(() => { if (!gone) setStatus('unavailable'); });
      }

      stop = startLiveReading({
        video: element, intervalMs: 200, regions,
        read: async (frame) => {
          if (qr) {
            const text = decodeQr(frame);
            if (text && (text !== lastQr || Date.now() - lastQrAt > 4000)) { lastQr = text; lastQrAt = Date.now(); cb.current.onQr?.(text); }
          }
          return plate && readerRef.current ? readerRef.current.read(frame) : [];
        },
        onPlate: (plateRead) => cb.current.onPlate(plateRead),
      });
    })();

    return () => { gone = true; stop(); stream?.getTracks().forEach((track) => track.stop()); };
  }, [qr, plate]); // eslint-disable-line react-hooks/exhaustive-deps

  async function captureNow() {
    const element = video.current;
    if (!element || !element.videoWidth) return;
    const scale = Math.min(1, 1280 / Math.max(element.videoWidth, element.videoHeight));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(element.videoWidth * scale), height: Math.round(element.videoHeight * scale) });
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    if (readerRef.current) {
      const reads = await readerRef.current.read(context.getImageData(0, 0, canvas.width, canvas.height));
      const top = reads.sort((a, b) => b.confidence - a.confidence)[0];
      if (top) { onPlate({ text: top.text, confidence: top.confidence, votes: 1 }); return; }
    }
    onSnap?.(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]!);
  }

  return (
    <div className="stack">
      <video ref={video} className="video" playsInline muted aria-label={t('att.camera')} />
      <div className="muted" style={{ textAlign: 'center' }} role="status">
        {error ? t('att.cameraDenied') : status === 'loading' ? t('att.readerLoading') : status === 'unavailable' ? t('att.readerOff') : t(qr && plate ? 'att.readerReady' : plate ? 'att.readerPlate' : 'att.scanning')}
      </div>
      {plate && <Button type="button" className="btn primary big" disabled={busy || !!error || status === 'starting' || status === 'loading'} onClick={() => void captureNow()}>{busy ? t('common.loading') : t('att.capture')}</Button>}
    </div>
  );
}
