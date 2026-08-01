/**
 * Perceptual hashing, used purely as a cost optimisation.
 *
 * Inference is by far the most expensive step in the pipeline, so the cheapest possible win
 * is *not running it*. Many real videos are highly redundant - static talking-head shots,
 * slideshows, letterboxed content, long dissolves - and adjacent samples from those are
 * pixel-wise near-identical. A 64-bit difference hash costs microseconds and lets us inherit
 * a neighbour's score instead of paying for a forward pass.
 *
 * dHash (gradient hash) rather than aHash or pHash:
 *  - aHash (mean threshold) is too brittle under brightness/contrast changes, so it reports
 *    "different" for frames that are visually the same and we lose the saving.
 *  - pHash (DCT) is more robust than we need and costs an actual transform.
 *  - dHash compares horizontally adjacent brightness values, so it encodes structure rather
 *    than absolute luminance: robust to exposure and gamma shifts, ~free to compute.
 */

/** Hash grid: 9 columns x 8 rows of comparisons -> 8 x 8 = 64 bits. */
const HASH_W = 9;
const HASH_H = 8;
export const HASH_BITS = (HASH_W - 1) * HASH_H;
export const HASH_HEX_LENGTH = HASH_BITS / 4;

/** ITU-R BT.601 luma. Matches how the eye weights the channels closely enough for this job. */
const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Compute a 64-bit dHash from RGBA pixel data of any size, returned as 16 lowercase hex chars.
 *
 * The source is box-averaged down to a 9x8 luma grid rather than point-sampled: point
 * sampling on real video aliases badly on fine detail (hair, foliage, text), which produces
 * unstable hashes and silently disables the dedupe saving.
 */
export function dHash(rgba: ArrayLike<number>, width: number, height: number): string {
  if (width <= 0 || height <= 0) throw new Error('dHash requires a non-empty image');
  if (rgba.length < width * height * 4) {
    throw new Error(`dHash: pixel buffer too small for ${width}x${height} RGBA`);
  }

  const grid = new Float64Array(HASH_W * HASH_H);

  for (let gy = 0; gy < HASH_H; gy++) {
    const y0 = Math.floor((gy * height) / HASH_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / HASH_H));
    for (let gx = 0; gx < HASH_W; gx++) {
      const x0 = Math.floor((gx * width) / HASH_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / HASH_W));

      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          const i = (row + x) * 4;
          sum += luma(rgba[i], rgba[i + 1], rgba[i + 2]);
          n++;
        }
      }
      grid[gy * HASH_W + gx] = n > 0 ? sum / n : 0;
    }
  }

  // Build the bitstring MSB-first so the hex string reads consistently.
  let hex = '';
  let nibble = 0;
  let bitsInNibble = 0;
  for (let gy = 0; gy < HASH_H; gy++) {
    for (let gx = 0; gx < HASH_W - 1; gx++) {
      const left = grid[gy * HASH_W + gx];
      const right = grid[gy * HASH_W + gx + 1];
      nibble = (nibble << 1) | (left < right ? 1 : 0);
      if (++bitsInNibble === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitsInNibble = 0;
      }
    }
  }
  return hex;
}

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Number of differing bits between two hex hashes.
 * Returns {@link HASH_BITS} (maximally different) if the inputs are not comparable, so a
 * malformed hash can never accidentally read as a duplicate.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return HASH_BITS;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number.parseInt(a[i], 16);
    const y = Number.parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return HASH_BITS;
    distance += POPCOUNT_NIBBLE[(x ^ y) & 0xf];
  }
  return distance;
}

/**
 * Fixed-capacity cache of recently classified frames, used to answer
 * "have I already paid for a frame that looks like this?".
 *
 * Bounded on purpose: an unbounded map would grow with video length, and comparing against
 * every frame ever seen is O(n) per sample for a rapidly diminishing hit rate. Recency is
 * what matters, because visual redundancy in video is overwhelmingly local.
 */
export class PerceptualCache<T> {
  private readonly entries: Array<{ hash: string; value: T }> = [];

  constructor(
    private readonly threshold: number,
    private readonly capacity = 24
  ) {}

  /** Closest stored value within the Hamming threshold, or `undefined`. */
  find(hash: string): T | undefined {
    let best: T | undefined;
    let bestDistance = this.threshold + 1;
    // Newest first: the most likely match is the most recent frame.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const d = hammingDistance(hash, this.entries[i].hash);
      if (d < bestDistance) {
        bestDistance = d;
        best = this.entries[i].value;
        if (d === 0) break;
      }
    }
    return bestDistance <= this.threshold ? best : undefined;
  }

  add(hash: string, value: T): void {
    this.entries.push({ hash, value });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
