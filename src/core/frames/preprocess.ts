import { MODEL_INPUT_SIZE, type FitMode } from '../config';
import { dHash } from '../dhash';
import { canvasToBitmap, createCanvas2D, type Canvas2D } from './canvas';

/**
 * Decoded frame -> model-ready bitmap + perceptual hash.
 *
 * The cheapest possible implementation of this step matters more than it looks. It runs on
 * every sampled frame, and the naive version (draw to a full-size canvas, `getImageData` the
 * whole thing, resize in JS) would move megabytes across the GPU/CPU boundary per frame and
 * dominate the pipeline on a phone.
 *
 * Two decisions avoid that:
 *
 *  1. Downscaling happens inside `createImageBitmap` via its resize options. That is the
 *     browser's own scaler - typically GPU, always native code - rather than a canvas
 *     `drawImage` round-trip or a tfjs resize kernel. It also means nsfwjs's internal
 *     `resizeBilinear` never fires, because the tensor already arrives at 224x224.
 *
 *  2. The perceptual hash is computed from a 36x32 readback, not from the 224x224 frame.
 *     4.6 KB crosses the boundary instead of 200 KB - roughly a 40x reduction in the only
 *     synchronous GPU->CPU stall in the hot path. 36x32 is chosen so it divides exactly into
 *     dHash's 9x8 comparison grid (4x4 pixel blocks), avoiding resampling artefacts that
 *     would destabilise the hash and quietly disable deduplication.
 */

/** Anything the platform accepts as an `ImageBitmapSource` that we actually produce. */
export type FrameLike = ImageBitmap | VideoFrame | HTMLVideoElement | OffscreenCanvas;

export interface PreparedFrame {
  /** Square, model-sized, ready for `fromPixels`. Caller owns it and must `close()` it. */
  bitmap: ImageBitmap;
  hash: string;
  /** Extra crops for `multiCrop`; empty otherwise. Caller must close these too. */
  extraCrops: ImageBitmap[];
}

/** Reused across frames - allocating a canvas per frame is pure waste. */
let hashSurface: Canvas2D | null = null;
let hashSurfaceTried = false;

const HASH_CANVAS_W = 36;
const HASH_CANVAS_H = 32;

function getHashContext(): Canvas2D['ctx'] | null {
  if (hashSurface) return hashSurface.ctx;
  if (hashSurfaceTried) return null;
  hashSurfaceTried = true;
  // `willReadFrequently` keeps the surface CPU-side, which is exactly right for a canvas whose
  // only purpose is to be read back every frame.
  hashSurface = createCanvas2D(HASH_CANVAS_W, HASH_CANVAS_H, { willReadFrequently: true });
  return hashSurface?.ctx ?? null;
}

/**
 * Resize with `createImageBitmap`, falling back to a canvas draw.
 *
 * The fallback exists because `createImageBitmap` resize options are not universally
 * implemented for every source type - notably `VideoFrame` on some engines - and losing the
 * whole fast path over one unsupported source combination would be a poor trade.
 */
async function toSquareBitmap(
  source: FrameLike,
  size: number,
  crop?: { x: number; y: number; width: number; height: number }
): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = {
    resizeWidth: size,
    resizeHeight: size,
    // 'low' on purpose: this is a 224x224 input to a MobileNet. Higher-quality resampling
    // costs measurably more and changes nothing the model can perceive.
    resizeQuality: 'low',
  };

  try {
    if (crop) {
      return await createImageBitmap(
        source as ImageBitmapSource,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        options
      );
    }
    return await createImageBitmap(source as ImageBitmapSource, options);
  } catch {
    const surface = createCanvas2D(size, size);
    if (!surface) throw new Error('no 2d context available for frame preprocessing');
    const src = sourceRect(source);
    const r = crop ?? src;
    surface.ctx.drawImage(
      source as CanvasImageSource,
      r.x,
      r.y,
      r.width,
      r.height,
      0,
      0,
      size,
      size
    );
    return await canvasToBitmap(surface.canvas);
  }
}

function sourceRect(source: FrameLike): { x: number; y: number; width: number; height: number } {
  if ('displayWidth' in source && typeof source.displayWidth === 'number') {
    // VideoFrame: displayWidth/Height account for the sample aspect ratio, whereas
    // codedWidth/Height include encoder alignment padding that must not be sampled.
    return { x: 0, y: 0, width: source.displayWidth, height: source.displayHeight };
  }
  if (source instanceof OffscreenCanvas) {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }
  const el = source as HTMLVideoElement;
  if (typeof el.videoWidth === 'number' && el.videoWidth > 0) {
    return { x: 0, y: 0, width: el.videoWidth, height: el.videoHeight };
  }
  const bmp = source as ImageBitmap;
  return { x: 0, y: 0, width: bmp.width, height: bmp.height };
}

/** Centred square crop of a rectangular frame. */
function centreSquare(rect: { width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const side = Math.min(rect.width, rect.height);
  return {
    x: Math.round((rect.width - side) / 2),
    y: Math.round((rect.height - side) / 2),
    width: side,
    height: side,
  };
}

/**
 * Two overlapping square crops of a wide frame.
 *
 * A centre crop of 16:9 discards ~43% of the width. For a "is there anything unsafe anywhere
 * in this frame" question that is a real recall hole, and it is worst exactly where framing
 * puts subjects: off to one side. Two crops at the left and right thirds cover the full width
 * with overlap through the middle, at 2x inference cost - which is why this is reserved for
 * refining frames that already look borderline rather than applied to everything.
 */
function wideCrops(rect: { width: number; height: number }): Array<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const side = Math.min(rect.width, rect.height);
  const maxX = Math.max(0, rect.width - side);
  const y = Math.round((rect.height - side) / 2);
  return [
    { x: 0, y, width: side, height: side },
    { x: maxX, y, width: side, height: side },
  ];
}

export async function prepareFrame(
  source: FrameLike,
  fit: FitMode,
  size: number = MODEL_INPUT_SIZE
): Promise<PreparedFrame> {
  const rect = sourceRect(source);
  const isWide = rect.width / Math.max(1, rect.height) > 1.5;

  let bitmap: ImageBitmap;
  const extraCrops: ImageBitmap[] = [];

  if (fit === 'centerCrop') {
    bitmap = await toSquareBitmap(source, size, centreSquare(rect));
  } else if (fit === 'multiCrop' && isWide) {
    const crops = wideCrops(rect);
    bitmap = await toSquareBitmap(source, size, crops[0]);
    extraCrops.push(await toSquareBitmap(source, size, crops[1]));
  } else {
    // `squash`: the full field of view at the cost of some aspect distortion. Default because
    // silently discarding part of every frame is a worse failure mode than mild stretching.
    bitmap = await toSquareBitmap(source, size);
  }

  return { bitmap, hash: hashOf(bitmap), extraCrops };
}

/**
 * 64-bit dHash of a prepared bitmap.
 *
 * Returns an all-zero hash if the readback is impossible (no 2d context, tainted surface).
 * That value is treated as "no useful hash" by the deduplication threshold check rather than
 * matching everything, so a hashing failure degrades into "run inference on every frame" -
 * slower, never wrong.
 */
export function hashOf(bitmap: ImageBitmap): string {
  const ctx = getHashContext();
  if (!ctx) return '0000000000000000';
  try {
    ctx.drawImage(bitmap, 0, 0, HASH_CANVAS_W, HASH_CANVAS_H);
    const data = ctx.getImageData(0, 0, HASH_CANVAS_W, HASH_CANVAS_H);
    return dHash(data.data, HASH_CANVAS_W, HASH_CANVAS_H);
  } catch {
    return '0000000000000000';
  }
}

/** Close every bitmap in a prepared frame. Safe to call more than once. */
export function releaseFrame(frame: PreparedFrame | null | undefined): void {
  if (!frame) return;
  try {
    frame.bitmap.close();
  } catch {
    /* already closed */
  }
  for (const crop of frame.extraCrops) {
    try {
      crop.close();
    } catch {
      /* already closed */
    }
  }
  frame.extraCrops.length = 0;
}
