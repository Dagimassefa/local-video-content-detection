import { createCanvas2D } from './canvas';
import { prepareFrame, releaseFrame } from './preprocess';
import { ScanError, type FrameSource, type FrameSourceOptions } from './FrameSource';
import type { FrameSourceKind, SampledFrame, VideoMeta } from '../types';

/**
 * Seek-based frame extraction through a `<video>` element.
 *
 * This is the path that always works: every container and codec the browser can play, every
 * engine, no demuxer, and HTTP range requests handle remote files without downloading them
 * whole. It is the *correct* choice for URLs and the *only* choice for WebM/MKV and for
 * browsers without WebCodecs - so it is implemented first and treated as the baseline rather
 * than as a degraded mode.
 *
 * Its cost is seek latency: 30-100 ms per sample, occasionally much worse, because each seek
 * flushes the decode pipeline and may trigger a network fetch. That single fact is the
 * strongest argument for the sampling design in `core/sampler.ts`: when a sample costs ~50 ms,
 * "decode at 1 fps" is not merely wasteful on a long video, it is impossible.
 *
 * Lives on the main thread by necessity - `<video>` is a DOM element and cannot exist in a
 * worker - so it is deliberately the only per-frame work the UI thread ever does, and it hands
 * the resulting bitmap straight to the worker as a transferable.
 */

/**
 * A seek that has not completed by now is treated as a failed frame.
 *
 * Seeks genuinely do hang: a truncated file, a byte range the server refuses, an unseekable
 * stream. Without a timeout the whole scan waits forever on one bad timestamp, which is a far
 * worse outcome than losing one sample out of a hundred.
 */
const SEEK_TIMEOUT_MS = 4_000;
const METADATA_TIMEOUT_MS = 15_000;

export class VideoElementFrameSource implements FrameSource {
  readonly kind: FrameSourceKind = 'video-element';

  private video: HTMLVideoElement | null = null;
  private meta: VideoMeta | null = null;
  private closed = false;
  /** Serialises seeks: a `<video>` has exactly one playhead, so requests cannot overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly src: string,
    private readonly options: FrameSourceOptions,
    /** True for `blob:`/same-origin sources, where CORS cannot be an issue. */
    private readonly sameOrigin: boolean
  ) {}

  async probe(signal?: AbortSignal): Promise<VideoMeta> {
    if (this.meta) return this.meta;

    // Cross-origin media needs an anonymous CORS request for the frames to be *readable*.
    // Without it the video plays fine but every pixel read throws a SecurityError, so we try
    // the readable configuration first and only fall back to a playback-only element.
    let video = await this.createVideo(!this.sameOrigin);
    let corsBlocked = false;

    if (!video && !this.sameOrigin) {
      // The server refused the CORS request. Retry without it: we will not be able to read
      // pixels, but the element still loads, so the player and mitigation UI remain usable and
      // we can report a precise reason instead of a generic failure.
      video = await this.createVideo(false);
      corsBlocked = true;
    }
    if (!video) {
      throw new ScanError(
        'The browser could not load this video. The URL may be unreachable, or the format unsupported.',
        'decode'
      );
    }
    this.video = video;
    throwIfAborted(signal);

    const durationSeconds = await resolveDuration(video);
    throwIfAborted(signal);
    if (durationSeconds === null) {
      throw new ScanError(
        'This video reports no finite duration and its seekable range could not be determined ' +
          '(a live stream, or an unseekable source). Sampling requires a known length.',
        'decode'
      );
    }

    // Prove readability now rather than discovering it 16 frames into a scan.
    //
    // The diagnosis has to distinguish "the browser forbids reading these pixels" from "something
    // else went wrong", because the advice differs completely: the first is unfixable client-side
    // and the user needs telling, the second is usually transient. An earlier version caught every
    // failure here and reported all of them as CORS, which meant a perfectly CORS-enabled URL that
    // hit an unrelated hiccup was told, wrongly and unhelpfully, that its server was misconfigured.
    if (corsBlocked || !this.sameOrigin) {
      const probe = await this.probeReadability(video);
      if (probe.status === 'tainted') {
        throw new ScanError(
          'This video is served without CORS headers, so the browser forbids reading its pixels. ' +
            'Detection is impossible for this URL - download the file and upload it instead, or ' +
            'serve it with Access-Control-Allow-Origin.',
          'cors'
        );
      }
      if (probe.status === 'failed') {
        throw new ScanError(
          `Could not read a frame from this video (${probe.detail}). The stream may be unseekable ` +
            'or the codec unsupported.',
          'decode'
        );
      }
    }

    this.meta = {
      durationMs: Math.floor(durationSeconds * 1000),
      width: video.videoWidth,
      height: video.videoHeight,
      kind: this.kind,
    };
    return this.meta;
  }

  private createVideo(withCors: boolean): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      if (withCors) video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      // Never attached to the document: it exists purely as a decoder we drive by seeking.

      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve(video);
      };
      const onError = () => {
        cleanup();
        video.removeAttribute('src');
        video.load();
        resolve(null);
      };
      const timer = setTimeout(onError, METADATA_TIMEOUT_MS);

      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
      video.src = this.src;
    });
  }

  /**
   * One throwaway 8x8 read, reporting precisely which step failed.
   *
   * Only a `SecurityError` means tainting. Everything else - a seek that never completed, an
   * unsupported codec, a missing 2d context - is a different problem with different advice, and
   * conflating them produces a confidently wrong error message.
   */
  private async probeReadability(
    video: HTMLVideoElement
  ): Promise<{ status: 'ok' } | { status: 'tainted' } | { status: 'failed'; detail: string }> {
    let bitmap: ImageBitmap | null = null;
    try {
      await this.seekTo(video, Math.min(0.1, video.duration / 2));
    } catch (err) {
      return { status: 'failed', detail: `seek failed: ${describe(err)}` };
    }
    try {
      bitmap = await createImageBitmap(video, { resizeWidth: 8, resizeHeight: 8 });
    } catch (err) {
      // Chrome raises SecurityError from createImageBitmap itself on a tainted video, before any
      // canvas is involved - so tainting has to be detected here as well as at getImageData.
      if (isSecurityError(err)) return { status: 'tainted' };
      return { status: 'failed', detail: `frame grab failed: ${describe(err)}` };
    }
    try {
      const surface = createCanvas2D(8, 8, { willReadFrequently: true });
      if (!surface) return { status: 'failed', detail: 'no 2d context available' };
      surface.ctx.drawImage(bitmap, 0, 0);
      surface.ctx.getImageData(0, 0, 1, 1); // throws SecurityError on a tainted source
      return { status: 'ok' };
    } catch (err) {
      if (isSecurityError(err)) return { status: 'tainted' };
      return { status: 'failed', detail: `pixel read failed: ${describe(err)}` };
    } finally {
      bitmap?.close();
    }
  }

  async frameAt(tsMs: number, signal?: AbortSignal): Promise<SampledFrame | null> {
    if (this.closed) return null;
    const video = this.video;
    const meta = this.meta;
    if (!video || !meta) throw new Error('frameAt called before probe()');

    // Serialise: concurrent seeks on one element interleave unpredictably and each would
    // invalidate the other's frame.
    const task = this.queue.then(() => this.grab(video, meta, tsMs, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async grab(
    video: HTMLVideoElement,
    meta: VideoMeta,
    tsMs: number,
    signal?: AbortSignal
  ): Promise<SampledFrame | null> {
    throwIfAborted(signal);

    // Keep a hair inside the end: seeking exactly to duration lands past the last frame on
    // several engines and either never fires `seeked` or yields a blank frame.
    const target = clamp(tsMs / 1000, 0, Math.max(0, meta.durationMs / 1000 - 0.05));

    try {
      await this.seekTo(video, target);
    } catch {
      return null;
    }
    throwIfAborted(signal);

    let prepared = null;
    try {
      prepared = await prepareFrame(video, this.options.fit, this.options.size);
      return {
        // The ACTUAL landed time, not the request: seeks snap to frame boundaries, and using
        // the requested value would put segment boundaries in slightly the wrong place.
        tsMs: Math.round(video.currentTime * 1000),
        bitmap: prepared.bitmap,
        hash: prepared.hash,
      };
    } catch {
      releaseFrame(prepared);
      return null;
    }
  }

  private seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already there (within a frame at 60fps): skip the round trip entirely. This matters
      // for the readability probe and for repeated requests at the same instant.
      if (Math.abs(video.currentTime - seconds) < 0.016 && video.readyState >= 2) {
        resolve();
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`seek to ${seconds}s failed`));
      };
      const timer = setTimeout(onError, SEEK_TIMEOUT_MS);

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      try {
        video.currentTime = seconds;
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const video = this.video;
    this.video = null;
    if (!video) return;
    // Explicitly tear down the media pipeline. Dropping the reference alone leaves the
    // decoder and any in-flight network fetch alive until GC decides otherwise.
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* the element is going away regardless */
    }
  }
}

/**
 * Establish a usable duration, including for files that do not declare one.
 *
 * `video.duration === Infinity` is not an exotic edge case - it is what you get from **anything
 * produced by `MediaRecorder`**, because a stream being recorded live has no known length at the
 * time its header is written and the WebM `Duration` element is left unset. Since "recorded in a
 * browser" describes a large share of real user-generated video, refusing those outright would
 * be a significant functional gap rather than a tidy limitation.
 *
 * Two recovery strategies, cheapest first:
 *
 *  1. `seekable.end()` - if the browser has already worked out the range, just read it.
 *  2. Seek far past the end. The engine clamps to the real final frame and fires `durationchange`
 *     with the actual value. This is an old and slightly grubby trick, but it is the only one
 *     that works, and it is reliable across engines.
 *
 * Returns `null` when the source genuinely has no end - a live stream - which the caller reports
 * as an honest, specific error rather than hanging.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number | null> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;

  if (video.seekable.length > 0) {
    const end = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }

  const discovered = await new Promise<number | null>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('durationchange', onChange);
      video.removeEventListener('seeked', onChange);
    };
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        cleanup();
        resolve(video.duration);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      // Last resort: the seek may have populated the seekable range even without a
      // durationchange event.
      if (video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);
        resolve(Number.isFinite(end) && end > 0 ? end : null);
      } else {
        resolve(null);
      }
    }, 3_000);

    video.addEventListener('durationchange', onChange);
    video.addEventListener('seeked', onChange);
    try {
      // Far enough past any plausible video to be clamped, but not so large that engines treat
      // it as invalid.
      video.currentTime = 1e7;
    } catch {
      cleanup();
      resolve(null);
    }
  });

  if (discovered === null) return null;
  // Rewind: we left the playhead past the end while probing.
  try {
    video.currentTime = 0;
  } catch {
    /* harmless - the first real seek will reposition it */
  }
  return discovered;
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** Tainting is signalled by a `SecurityError` DOMException, and by nothing else. */
function isSecurityError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'SecurityError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('scan cancelled', 'AbortError');
}
