import type { Frame } from './image.js';
import { PlateStabilizer } from './plates.js';
import type { PlateRead } from './reader.js';

export interface LivePlate { text: string; confidence: number; votes: number }

/**
 * Read frames from a playing <video> a few times a second until one plate is stable, then call `onPlate` once.
 * Frames are downscaled first (a phone camera is 12 MP; the detector sees 384 px), which keeps phones cool and fast.
 */
export function startLiveReading(opts: {
  video: HTMLVideoElement; read: (f: Frame) => Promise<PlateRead[]>; regions: string[]; onPlate: (p: LivePlate) => void; onFrame?: (reads: PlateRead[]) => void; intervalMs?: number;
}) {
  const stab = new PlateStabilizer(opts.regions);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let stopped = false; let timer = 0;

  const loop = async () => {
    const v = opts.video;
    if (stopped) return;
    if (v.readyState >= 2 && v.videoWidth && !document.hidden) {
      const k = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      canvas.width = Math.round(v.videoWidth * k); canvas.height = Math.round(v.videoHeight * k);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      try {
        const reads = await opts.read(ctx.getImageData(0, 0, canvas.width, canvas.height));
        opts.onFrame?.(reads);
        const hit = stab.push(reads);
        if (hit && !stopped) { stopped = true; opts.onPlate(hit); return; }
      } catch { /* a bad frame is skipped */ }
    }
    timer = window.setTimeout(loop, opts.intervalMs ?? 250);
  };
  timer = window.setTimeout(loop, 300);
  return () => { stopped = true; clearTimeout(timer); };
}
