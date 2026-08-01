import * as Comlink from 'comlink';
import { NsfwDetector } from '../core/detector/nsfwDetector';
import { loadViolenceManifest, ViolenceDetector } from '../core/detector/violenceDetector';
import type { Detector } from '../core/detector/Detector';
import type { ScanConfig } from '../core/config';
import { createCanvas2D } from '../core/frames/canvas';
import { ScanError, type FrameSource } from '../core/frames/FrameSource';
import { runScan } from '../core/pipeline';
import type { ScanEvent } from '../core/types';
import type { RemoteFrameSource, ScanWorkerApi } from './protocol';

/**
 * The orchestrator worker: owns the model, runs the pipeline, streams results out.
 *
 * The pipeline lives HERE rather than on the main thread because the sampler's next decision
 * depends on the score of the frame that just came back. Running it beside the detectors keeps
 * that whole feedback loop - decide, decode, classify, aggregate, decide again - off the UI
 * thread entirely. The main thread's only job is to render whatever arrives.
 *
 * The detectors are kept alive across scans on purpose: re-initialising means re-fetching
 * weights, re-selecting a backend and re-compiling shaders, which is by far the most expensive
 * thing in the system. Scanning a second video should be near-instant to start, and it is.
 */

/**
 * Detectors, built once and reused across scans.
 *
 * Today this is a single sexual-content detector. Registering another category means pushing a second
 * `Detector` into this array - the pipeline composes their per-category scores and everything
 * downstream (scoring, aggregation, the reported taxonomy) already handles the general case. See
 * `core/categories.ts` for the taxonomy and for why a weak second detector was rejected rather than
 * shipped.
 */
let detectors: Detector[] | null = null;
/** Which violence setting the cached `detectors` array was built for. */
let activeViolence = false;
let abort: AbortController | null = null;

/** Resolved when the scan is allowed to proceed; replaced with a fresh promise when paused. */
let pauseGate: { promise: Promise<void>; release: () => void } | null = null;

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/**
 * Small WebP thumbnails for flagged frames.
 *
 * WebP at low quality, 96 px: a flagged-frame thumbnail is displayed at roughly thumbnail size
 * behind a CSS blur, so anything larger is bytes spent on detail that is deliberately being
 * hidden. Only ever called for frames that crossed the threshold, so the cost is bounded by
 * the number of detections rather than by the number of samples.
 */
async function makeThumbnail(bitmap: ImageBitmap): Promise<string | undefined> {
  try {
    const size = 96;
    // Worker context, so there is no `<canvas>` fallback. On engines without OffscreenCanvas the
    // thumbnail is simply skipped — the timeline shows a placeholder and the scan is unaffected.
    const surface = createCanvas2D(size, size);
    if (!surface || !('convertToBlob' in surface.canvas)) return undefined;
    surface.ctx.drawImage(bitmap, 0, 0, size, size);
    const blob = await surface.canvas.convertToBlob({ type: 'image/webp', quality: 0.5 });
    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:image/webp;base64,${btoa(binary)}`;
  } catch {
    // A thumbnail is a nicety. Never let it break a scan.
    return undefined;
  }
}

const api: ScanWorkerApi = {
  async scan(
    sourcePort: MessagePort,
    config: ScanConfig,
    onEvent: (event: ScanEvent) => void
  ): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    pauseGate = null;

    const remote = Comlink.wrap<RemoteFrameSource>(sourcePort);

    // Adapt the Comlink proxy to the plain `FrameSource` the pipeline expects. Comlink returns
    // a proxy whose every member is a promise, so `kind` cannot be read across the boundary -
    // it is supplied by `probe()`'s metadata instead.
    let kind: FrameSource['kind'] = 'video-element';
    const source: FrameSource = {
      get kind() {
        return kind;
      },
      async probe() {
        const result = await remote.probe();
        if (!result.ok) {
          // Reconstruct the typed error on this side of the boundary, with its kind intact.
          throw new ScanError(result.message, result.kind);
        }
        kind = result.value.kind;
        return result.value;
      },
      frameAt: (tsMs) => remote.frameAt(tsMs),
      close: () => {
        void remote.close();
      },
    };

    // Detectors are cached across scans (re-initialising means re-fetching weights and recompiling
    // shaders), but the SET of them depends on config. Caching on `!detectors` alone meant toggling
    // violence in the UI did nothing until a page reload - a control that silently ignores you is
    // worse than no control.
    if (!detectors || activeViolence !== config.violenceDetection) {
      for (const detector of detectors ?? []) detector.dispose();
      detectors = [new NsfwDetector()];
      activeViolence = config.violenceDetection;

      // Violence screening is opt-in AND requires the 86.8 MB model to have been vendored. Absent
      // either, the scan silently runs NSFW-only and the reported taxonomy says violence was not
      // screened - the correct, honest degradation.
      if (config.violenceDetection) {
        const manifest = await loadViolenceManifest();
        if (manifest) detectors.push(new ViolenceDetector(manifest));
      }
    }

    try {
      await runScan({
        source,
        detectors,
        config,
        emit: (event) => {
          // Fire-and-forget across the boundary: awaiting each event would make the pipeline's
          // speed a function of main-thread render latency, which is exactly backwards.
          void onEvent(event);
        },
        signal: abort.signal,
        waitWhilePaused: () => pauseGate?.promise ?? Promise.resolve(),
        makeThumbnail,
      });
    } catch (err) {
      if (err instanceof ScanError) {
        onEvent({ type: 'error', message: err.message, kind: err.kind });
      } else if (!abort.signal.aborted) {
        onEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          kind: 'unknown',
        });
      }
    } finally {
      source.close();
      sourcePort.close();
    }
  },

  cancel() {
    // Release the gate first, or a scan paused on a hidden tab would sit there forever
    // instead of noticing it has been cancelled.
    pauseGate?.release();
    pauseGate = null;
    abort?.abort();
  },

  setPaused(paused: boolean) {
    if (paused) {
      if (!pauseGate) pauseGate = makeGate();
    } else {
      pauseGate?.release();
      pauseGate = null;
    }
  },

  dispose() {
    abort?.abort();
    for (const detector of detectors ?? []) detector.dispose();
    detectors = null;
    activeViolence = false;
  },
};

Comlink.expose(api);
