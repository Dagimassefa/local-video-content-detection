import { describe, expect, it } from 'vitest';
import { softmax } from './violenceDetector';

/**
 * The ViolenceDetector's browser-dependent half (ONNX session, canvas, ImageBitmap) is not unit-tested
 * for the same reason the frame sources are not: a mocked `InferenceSession` would only assert that the
 * mock was called. It is exercised for real by `scripts/eval-violence-model.mjs`, which loads the actual
 * model in a real browser and is what established that the available checkpoint is unfit.
 *
 * What IS tested here is the pure maths, because a wrong softmax silently rescales every score.
 */
describe('softmax', () => {
  it('produces a distribution that sums to one', () => {
    const out = softmax([1, 2, 3]);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('preserves ordering', () => {
    const out = softmax([0.5, 2.5, -1]);
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[0]).toBeGreaterThan(out[2]);
  });

  it('is uniform for equal logits', () => {
    expect(softmax([3, 3, 3, 3])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('does not overflow on large logits', () => {
    // Subtracting the max is what prevents `exp(1000)` becoming Infinity and every output NaN.
    const out = softmax([1000, 999]);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(out[0] + out[1]).toBeCloseTo(1, 10);
    expect(out[0]).toBeGreaterThan(out[1]);
  });

  it('does not underflow on very negative logits', () => {
    const out = softmax([-1000, -1001]);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('handles a single logit', () => {
    expect(softmax([42])).toEqual([1]);
  });

  it('matches a hand-computed two-class case', () => {
    // exp(0)/(exp(0)+exp(ln 3)) = 1/4, and 3/4.
    const out = softmax([0, Math.log(3)]);
    expect(out[0]).toBeCloseTo(0.25, 10);
    expect(out[1]).toBeCloseTo(0.75, 10);
  });
});

/**
 * Guards the property that made the whole taxonomy worth building: a category nobody screened must
 * never look like a category that was screened and came back clean.
 */
describe('violence category is not silently reported as clean', () => {
  it('is absent from the taxonomy as screened', async () => {
    const { CATEGORY_META, screenedCategories } = await import('../categories');
    expect(CATEGORY_META.violence.screened).toBe(false);
    expect(screenedCategories()).not.toContain('violence');
  });

  it('documents why it is not screened, referencing the evaluation', async () => {
    const { CATEGORY_META } = await import('../categories');
    expect(CATEGORY_META.violence.requires).toMatch(/eval-violence-model/);
  });

  it('is off by default in the shipped config', async () => {
    const { DEFAULT_SCAN_CONFIG } = await import('../config');
    expect(DEFAULT_SCAN_CONFIG.violenceDetection).toBe(false);
  });
});
