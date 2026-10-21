import { cropResizeRgb, letterbox, type Frame } from './image.js';

/** The slice of onnxruntime (web or node) the reader needs; the caller supplies the real thing. */
export interface OrtTensorLike { data: ArrayLike<number>; dims: readonly number[] }
export interface OrtSessionLike { inputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>> }
export interface OrtLike { Tensor: new (type: string, data: ArrayLike<number> | Uint8Array | Float32Array, dims: number[]) => unknown }

export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
export const PAD = '_';
const SLOTS = 10, DET_SIZE = 384, OCR_W = 128, OCR_H = 64;

export interface PlateRead { text: string; confidence: number; box: [number, number, number, number]; detection: number }

/** The detector's rows are [batch, x1, y1, x2, y2, class, score] in letterboxed pixels; map them back onto the frame. */
export function parseDetections(rows: OrtTensorLike, lb: { scale: number; padX: number; padY: number }, f: { width: number; height: number }, minScore = 0.4) {
  const n = rows.dims.length === 2 ? rows.dims[0]! : Math.floor(rows.data.length / 7);
  const out: { box: [number, number, number, number]; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = Array.from({ length: 7 }, (_, k) => Number(rows.data[i * 7 + k]));
    const score = r[6]!;
    if (!(score >= minScore)) continue;
    const un = (v: number, pad: number, max: number) => Math.max(0, Math.min(max, Math.round((v - pad) / lb.scale)));
    const box: [number, number, number, number] = [un(r[1]!, lb.padX, f.width), un(r[2]!, lb.padY, f.height), un(r[3]!, lb.padX, f.width), un(r[4]!, lb.padY, f.height)];
    if (box[2] - box[0] >= 4 && box[3] - box[1] >= 4) out.push({ box, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Decode the OCR head: [1, 10, 37] probabilities → text without padding, and the mean probability of the kept characters. */
export function decodePlate(probs: ArrayLike<number>): { text: string; confidence: number } {
  const A = ALPHABET.length;
  let text = ''; let sum = 0; let n = 0;
  for (let s = 0; s < SLOTS; s++) {
    let best = 0;
    for (let k = 1; k < A; k++) if (probs[s * A + k]! > probs[s * A + best]!) best = k;
    if (ALPHABET[best] === PAD) continue;
    text += ALPHABET[best]; sum += probs[s * A + best]!; n++;
  }
  return { text, confidence: n ? sum / n : 0 };
}

/** Detector + OCR over one RGBA frame. Sessions are created by the caller (browser: onnxruntime-web; tests: onnxruntime-node). */
export function createReader(ort: OrtLike, detector: OrtSessionLike, ocr: OrtSessionLike, opts: { minDetection?: number } = {}) {
  return {
    async read(frame: Frame): Promise<PlateRead[]> {
      const lb = letterbox(frame, DET_SIZE);
      const out = await detector.run({ [detector.inputNames[0]!]: new ort.Tensor('float32', lb.tensor, [1, 3, DET_SIZE, DET_SIZE]) });
      const boxes = parseDetections(Object.values(out)[0]!, lb, frame, opts.minDetection ?? 0.4).slice(0, 4);
      const reads: PlateRead[] = [];
      for (const d of boxes) {
        const px = cropResizeRgb(frame, d.box, OCR_W, OCR_H);
        const res = await ocr.run({ [ocr.inputNames[0]!]: new ort.Tensor('uint8', px, [1, OCR_H, OCR_W, 3]) });
        const { text, confidence } = decodePlate((res.plate ?? Object.values(res)[0]!).data);
        if (text) reads.push({ text, confidence, box: d.box, detection: d.score });
      }
      return reads;
    },
  };
}
