/** Pixel work for the plate reader. Pure functions over RGBA frames, so they run the same in the browser and in tests. */
export interface Frame { data: Uint8ClampedArray | Uint8Array; width: number; height: number }

/** Bilinear sample with OpenCV's pixel-centre alignment, so results match the Python reference. */
function sample(f: Frame, x: number, y: number, c: number): number {
  const x0 = Math.max(0, Math.min(f.width - 1, Math.floor(x))), y0 = Math.max(0, Math.min(f.height - 1, Math.floor(y)));
  const x1 = Math.min(f.width - 1, x0 + 1), y1 = Math.min(f.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const px = (xx: number, yy: number) => f.data[(yy * f.width + xx) * 4 + c]!;
  const top = px(x0, y0) * (1 - fx) + px(x1, y0) * fx;
  const bot = px(x0, y1) * (1 - fx) + px(x1, y1) * fx;
  return top * (1 - fy) + bot * fy;
}

export interface Letterboxed { tensor: Float32Array; scale: number; padX: number; padY: number }

/** Fit the frame inside size×size keeping its aspect ratio, pad with grey 114, and emit RGB/255 as planar CHW floats. */
export function letterbox(f: Frame, size = 384): Letterboxed {
  const scale = Math.min(size / f.height, size / f.width);
  const w = Math.round(f.width * scale), h = Math.round(f.height * scale);
  const padX = Math.floor((size - w) / 2), padY = Math.floor((size - h) / 2);
  const plane = size * size, tensor = new Float32Array(3 * plane).fill(114 / 255);
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / scale - 0.5, o = (y + padY) * size + x + padX;
      for (let c = 0; c < 3; c++) tensor[c * plane + o] = sample(f, sx, sy, c) / 255;
    }
  }
  return { tensor, scale, padX, padY };
}

/** Crop [x1,y1,x2,y2] and resize to w×h as interleaved RGB bytes (NHWC), the OCR model's input. */
export function cropResizeRgb(f: Frame, box: [number, number, number, number], w: number, h: number): Uint8Array {
  const [x1, y1, x2, y2] = box;
  const cw = Math.max(1, x2 - x1), ch = Math.max(1, y2 - y1);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = y1 + (y + 0.5) * (ch / h) - 0.5;
    for (let x = 0; x < w; x++) {
      const sx = x1 + (x + 0.5) * (cw / w) - 0.5, o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(sample(f, sx, sy, c));
    }
  }
  return out;
}
