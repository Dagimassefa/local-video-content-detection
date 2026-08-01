/**
 * Canvas creation that does not assume `OffscreenCanvas` exists.
 *
 * Found by the cross-engine matrix (`npm run matrix`): the app failed outright on WebKit with
 * `Can't find variable: OffscreenCanvas`. That is not an obscure engine — WebKit is what Safari
 * ships, **including on iOS**, which is half the stated production target. The app was completely
 * non-functional there while working perfectly in every Chromium-based browser tested.
 *
 * `OffscreenCanvas` is genuinely unavailable or partial in some WebKit builds, and it is the only
 * canvas available inside a worker. So the strategy differs by context:
 *
 *   - **Main thread:** fall back to a detached `<canvas>` element, which works everywhere.
 *   - **Worker:** there is no fallback, so callers must degrade gracefully instead of throwing.
 *     Every worker-side use is either optional (thumbnails, perceptual hashing) or has an
 *     alternative path (warm-up via `ImageData`).
 *
 * The general shape of the lesson: a feature that is "widely supported" per the tables can still be
 * missing on the one engine that matters most for your target, and only running there tells you.
 */

export const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

export interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

/**
 * A 2D drawing surface, or `null` if none can be created here.
 *
 * `willReadFrequently` is passed through because every caller in this codebase reads pixels back —
 * it asks the browser to keep the surface CPU-side, which is exactly right for that pattern.
 */
export function createCanvas2D(
  width: number,
  height: number,
  options: { willReadFrequently?: boolean } = {}
): Canvas2D | null {
  const attrs = options.willReadFrequently ? { willReadFrequently: true } : undefined;

  if (hasOffscreenCanvas) {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', attrs) as OffscreenCanvasRenderingContext2D | null;
      if (ctx) return { canvas, ctx };
    } catch {
      // Fall through to the DOM canvas.
    }
  }

  // Main thread only. In a worker there is no `document`, and callers handle the null.
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', attrs) as CanvasRenderingContext2D | null;
      if (ctx) return { canvas, ctx };
    } catch {
      /* nothing available */
    }
  }

  return null;
}

/**
 * Convert a drawing surface to an `ImageBitmap`.
 *
 * Both canvas kinds are valid `ImageBitmapSource`s, but they need separate handling for typing, and
 * `HTMLCanvasElement` is only reachable on the main thread.
 */
export function canvasToBitmap(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ImageBitmap> {
  return createImageBitmap(canvas as CanvasImageSource);
}
