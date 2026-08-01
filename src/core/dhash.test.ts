import { describe, expect, it } from 'vitest';
import { dHash, HASH_BITS, HASH_HEX_LENGTH, hammingDistance, PerceptualCache } from './dhash';

/** Build an RGBA buffer from a per-pixel grey function. */
function image(
  width: number,
  height: number,
  grey: (x: number, y: number) => number
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = grey(x, y);
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

const W = 64;
const H = 64;

// A structured mid-range test image. Mid-range on purpose, so brightness-shift tests are not
// silently invalidated by 8-bit clipping.
const structured = (x: number, y: number) => 100 + 40 * Math.sin(x / 5) + 20 * Math.cos(y / 7);

describe('dHash', () => {
  it('returns a 64-bit hash as 16 hex characters', () => {
    const h = dHash(image(W, H, structured), W, H);
    expect(h).toHaveLength(HASH_HEX_LENGTH);
    expect(HASH_HEX_LENGTH).toBe(16);
    expect(HASH_BITS).toBe(64);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable: the same image always hashes identically', () => {
    const a = dHash(image(W, H, structured), W, H);
    const b = dHash(image(W, H, structured), W, H);
    expect(a).toBe(b);
  });

  it('is invariant to a uniform brightness shift', () => {
    // The property that makes dedupe actually pay off. Video encoders and auto-exposure shift
    // overall brightness constantly between adjacent frames of the same shot; a hash that
    // called those "different" would disable the saving exactly where it matters most.
    const base = dHash(image(W, H, structured), W, H);
    const brighter = dHash(image(W, H, (x, y) => structured(x, y) + 40), W, H);
    expect(brighter).toBe(base);
  });

  it('is invariant to a contrast scale', () => {
    const base = dHash(image(W, H, structured), W, H);
    const flatter = dHash(image(W, H, (x, y) => structured(x, y) * 0.7 + 30), W, H);
    expect(flatter).toBe(base);
  });

  it('separates structurally different images', () => {
    const horizontal = dHash(image(W, H, (x) => (x < W / 2 ? 20 : 220)), W, H);
    const vertical = dHash(image(W, H, (_x, y) => (y < H / 2 ? 20 : 220)), W, H);
    expect(hammingDistance(horizontal, vertical)).toBeGreaterThan(8);
  });

  it('separates an image from its inverse', () => {
    const normal = dHash(image(W, H, structured), W, H);
    const inverted = dHash(image(W, H, (x, y) => 255 - structured(x, y)), W, H);
    // Inversion flips every gradient comparison, so essentially every bit should differ.
    expect(hammingDistance(normal, inverted)).toBeGreaterThan(HASH_BITS * 0.75);
  });

  it('box-averages rather than point-samples, so fine detail does not alias', () => {
    // A 1-pixel checkerboard point-sampled at 9x8 produces a hash that flips with a
    // one-pixel shift. Averaging makes both read as uniform, which is the honest answer.
    const checker = dHash(image(W, H, (x, y) => ((x + y) % 2 === 0 ? 0 : 255)), W, H);
    const shifted = dHash(image(W, H, (x, y) => ((x + y + 1) % 2 === 0 ? 0 : 255)), W, H);
    expect(hammingDistance(checker, shifted)).toBeLessThanOrEqual(4);
  });

  it('handles images smaller than the hash grid', () => {
    expect(() => dHash(image(4, 4, structured), 4, 4)).not.toThrow();
    expect(dHash(image(4, 4, structured), 4, 4)).toHaveLength(HASH_HEX_LENGTH);
  });

  it('rejects malformed input rather than hashing garbage', () => {
    expect(() => dHash(new Uint8ClampedArray(4), 0, 0)).toThrow();
    expect(() => dHash(new Uint8ClampedArray(16), 32, 32)).toThrow(/too small/);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('a1b2c3d4e5f60718', 'a1b2c3d4e5f60718')).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('is symmetric', () => {
    expect(hammingDistance('12ab', '34cd')).toBe(hammingDistance('34cd', '12ab'));
  });

  it('treats unusable input as maximally different, never as a duplicate', () => {
    // Failing safe matters here: a malformed hash reading as distance 0 would skip inference
    // on a frame we know nothing about.
    expect(hammingDistance('', '')).toBe(HASH_BITS);
    expect(hammingDistance('abcd', 'abcdef')).toBe(HASH_BITS);
    expect(hammingDistance('zzzz', '0000')).toBe(HASH_BITS);
  });
});

describe('PerceptualCache', () => {
  it('returns nothing when empty', () => {
    expect(new PerceptualCache<number>(6).find('0000000000000000')).toBeUndefined();
  });

  it('finds an exact match', () => {
    const cache = new PerceptualCache<string>(6);
    cache.add('0000000000000000', 'first');
    expect(cache.find('0000000000000000')).toBe('first');
  });

  it('finds a near match within the threshold', () => {
    const cache = new PerceptualCache<string>(6);
    cache.add('0000000000000000', 'first');
    // Three bits different - within a threshold of 6.
    expect(cache.find('0000000000000007')).toBe('first');
  });

  it('rejects a match beyond the threshold', () => {
    const cache = new PerceptualCache<string>(6);
    cache.add('0000000000000000', 'first');
    expect(cache.find('00000000000000ff')).toBeUndefined();
  });

  it('prefers the closest match, not merely the first acceptable one', () => {
    const cache = new PerceptualCache<string>(8);
    cache.add('0000000000000000', 'far');
    cache.add('000000000000000f', 'near');
    expect(cache.find('000000000000000e')).toBe('near');
  });

  it('evicts oldest entries beyond capacity', () => {
    // Bounded on purpose: an unbounded cache grows with video length and scans linearly for
    // a rapidly diminishing hit rate. Visual redundancy in video is local.
    const cache = new PerceptualCache<number>(0, 2);
    cache.add('0000000000000000', 1);
    cache.add('ffffffffffffffff', 2);
    cache.add('0f0f0f0f0f0f0f0f', 3);
    expect(cache.size).toBe(2);
    expect(cache.find('0000000000000000')).toBeUndefined();
    expect(cache.find('ffffffffffffffff')).toBe(2);
  });

  it('clears', () => {
    const cache = new PerceptualCache<number>(6);
    cache.add('0000000000000000', 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.find('0000000000000000')).toBeUndefined();
  });
});
