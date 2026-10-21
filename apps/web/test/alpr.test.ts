// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePlate } from '../src/alpr/reader.js';
import { PlateStabilizer, matchesRegistry } from '../src/alpr/plates.js';

describe('plate formats', () => {
  it('accepts real formats for the configured regions and rejects noise', () => {
    expect(matchesRegistry('XYZ789', ['MX'])).toBe(true);
    expect(matchesRegistry('xyz-789', ['MX'])).toBe(true);
    expect(matchesRegistry('BRA2E19', ['BR'])).toBe(true);
    expect(matchesRegistry('BRA2E19', ['MX'])).toBe(false);
    expect(matchesRegistry('12', [])).toBe(false);
    expect(matchesRegistry('QQQQQQQQ', ['MX'])).toBe(false);
  });
});

describe('OCR decoding', () => {
  it('reads the highest-probability character in each slot and drops padding', () => {
    const A = 37, probs = new Float32Array(10 * A);
    const put = (slot: number, ch: string, p = 0.9) => { probs[slot * A + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_'.indexOf(ch)] = p; };
    'AB12'.split('').forEach((c, i) => put(i, c));
    for (let s = 4; s < 10; s++) put(s, '_', 1);
    expect(decodePlate(probs)).toEqual({ text: 'AB12', confidence: expect.closeTo(0.9, 5) });
  });
});

describe('PlateStabilizer', () => {
  const read = (text: string, confidence = 0.9) => [{ text, confidence }];
  it('waits for the same valid plate in two frames', () => {
    const s = new PlateStabilizer(['MX']);
    expect(s.push(read('XYZ789'))).toBeNull();
    expect(s.push(read('XYZ789'))).toMatchObject({ text: 'XYZ789', votes: 2 });
  });
  it('ignores a one-frame misread, invalid formats and low confidence', () => {
    const s = new PlateStabilizer(['MX']);
    expect(s.push(read('XYZ789'))).toBeNull();
    expect(s.push(read('XYZ780'))).toBeNull();
    expect(s.push(read('QQQQQQ'))).toBeNull();
    expect(s.push(read('ABC123', 0.3))).toBeNull();
    expect(s.push(read('ABC123', 0.3))).toBeNull();
  });
  it('lets the majority win when frames disagree', () => {
    const s = new PlateStabilizer(['MX']);
    s.push(read('XYZ789')); s.push(read('XYZ788')); 
    expect(s.push(read('XYZ789'))).toMatchObject({ text: 'XYZ789', votes: 2 });
  });
});

// Parity with the Python reference (services/alpr): the same images must read the same text.
const fixtures = `${resolve(process.cwd(), 'test/fixtures/plates')}/`;
const models = `${resolve(process.cwd(), 'public/models')}/`;
const haveModels = (() => { try { readFileSync(`${models}cct_s_v2_global.onnx`); return true; } catch { return false; } })();

describe.skipIf(!haveModels)('plate reader parity with the Python reference', () => {
  it('reads the fixture images the way fast-alpr does', async () => {
    const [ort, sharp] = await Promise.all([import('onnxruntime-node'), import('sharp').then((m) => m.default)]);
    const { createReader } = await import('../src/alpr/reader.js');
    const det = await ort.InferenceSession.create(`${models}yolo-v9-t-384-license-plates-end2end.onnx`);
    const ocr = await ort.InferenceSession.create(`${models}cct_s_v2_global.onnx`);
    const reader = createReader(ort as never, det as never, ocr as never);
    const expected = JSON.parse(readFileSync(`${fixtures}expected.json`, 'utf8')) as Record<string, { reads: { text: string; box: number[] }[] }>;
    for (const [name, want] of Object.entries(expected)) {
      const { data, info } = await sharp(`${fixtures}${name}.jpg`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const got = await reader.read({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
      // Everything the reference found, we find with the same text and (nearly) the same box.
      for (const w of want.reads) {
        const g = got.find((x) => x.text === w.text);
        expect(g, `${name}: expected ${w.text}, got ${got.map((x) => x.text).join(',') || 'nothing'}`).toBeTruthy();
        w.box.forEach((v, i) => expect(Math.abs(g!.box[i]! - v)).toBeLessThanOrEqual(6));
      }
      if (!want.reads.length) expect(got.filter((x) => x.confidence > 0.9 && x.detection > 0.6), `${name}: no confident read expected`).toEqual([]);
    }
  }, 60_000);
});
