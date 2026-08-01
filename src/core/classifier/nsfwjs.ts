import { MODEL_BASE_URL, MODEL_INPUT_SIZE } from '../config';
import { classScoresFromPredictions } from '../scorer';
import type { BackendId, BackendInfo, BackendPref, ClassScores } from '../types';
import { backendChain, type Classifier } from './Classifier';

/**
 * NSFWJS MobileNetV2 running on TensorFlow.js.
 *
 * Everything TFJS-shaped is confined to this file. The rest of the engine talks to
 * {@link Classifier} and has no idea which runtime is underneath.
 *
 * Two things worth knowing about how nsfwjs behaves internally, both of which shaped this
 * wrapper (verified by reading its source, not assumed):
 *
 *  1. `infer()` normalises by dividing by 255 and only calls `tf.image.resizeBilinear` when
 *     the input is not already the model's input size. We hand it exactly 224x224 bitmaps
 *     downscaled by `createImageBitmap`, so that resize is skipped entirely - the browser's
 *     own (typically GPU) scaler does the work instead of a tfjs kernel.
 *
 *  2. `load()` already runs a warm-up `predict` on a zero tensor and awaits `.data()`. So the
 *     shader compilation and kernel JIT are paid during load, not on the user's first real
 *     frame. We still time a second warm-up on a realistic bitmap, because on WebGL the first
 *     *`fromPixels`* upload path compiles its own programs.
 */

/** Lazily-imported tfjs namespace - typed structurally so this module needs no tfjs types. */
interface TfLike {
  ready(): Promise<void>;
  setBackend(name: string): Promise<boolean>;
  getBackend(): string;
  browser: { fromPixels(source: ImageBitmap): TfTensor };
  memory(): { numTensors: number; numBytes: number };
  engine(): { endScope(): void; startScope(): void };
}

interface TfTensor {
  dispose(): void;
}

interface NsfwModelLike {
  classify(
    img: TfTensor,
    topk?: number
  ): Promise<Array<{ className: string; probability: number }>>;
  dispose(): void;
}

export class NsfwjsClassifier implements Classifier {
  readonly id = 'nsfwjs-mobilenet-v2';
  readonly inputSize = MODEL_INPUT_SIZE;

  private tf: TfLike | null = null;
  private model: NsfwModelLike | null = null;
  private disposed = false;

  constructor(private readonly modelBaseUrl: string = MODEL_BASE_URL) {}

  /**
   * Cached result of a successful `init`, keyed by the requested backend.
   *
   * Without this, every scan called `nsfwjs.load()` again and built a whole second model while the
   * first was still alive - a leak of the model's entire tensor set per scan, measured as
   * 267 → 534 → 801 → 1068 → 1335 tensors across five back-to-back scans. It also meant paying the
   * full ~1.2 s load (and up to 17 s on WebGL) on every single scan.
   *
   * Found by `npm run verify`, which asserts the tensor count stays flat across repeated scans. It
   * is exactly the kind of bug that is invisible in one-shot manual testing and ruinous in a feed.
   */
  private initialised: { pref: BackendPref; info: BackendInfo } | null = null;

  async init(pref: BackendPref, signal?: AbortSignal): Promise<BackendInfo> {
    if (this.initialised && this.initialised.pref === pref && this.model) {
      // Report zero for load and warm-up: those costs were genuinely not paid this time, and
      // reporting the original figures would overstate the cost of a warm scan.
      return { ...this.initialised.info, modelLoadMs: 0, warmupMs: 0, servedFromCache: true };
    }
    // A different backend was requested: tear the old one down before building another.
    if (this.model) this.disposeModel();

    const t0 = now();

    // Dynamic import, deliberately. tfjs plus its backends is by far the largest thing in the
    // dependency graph, and a user who lands on the page and never scans a video should not
    // pay for it. This keeps the initial bundle small and moves the ML payload to the moment a
    // scan actually starts. Same reason the weights are fetched rather than bundled.
    const [core, tfjs] = await Promise.all([
      import('@tensorflow/tfjs'),
      import('nsfwjs/core'),
    ]);
    const tf = core as unknown as TfLike;
    this.tf = tf;
    throwIfAborted(signal);

    const { backend, fallbackReason } = await this.selectBackend(tf, pref);
    throwIfAborted(signal);

    // Same-origin static assets vendored by `scripts/fetch-models.mjs`. No CDN, no inference
    // API - the "runs entirely locally" requirement is structural here, not a promise.
    const weightBytes = await measureWeightFetch(this.modelBaseUrl);

    const model = (await (tfjs as { load: (url: string, opts?: object) => Promise<NsfwModelLike> })
      .load(this.modelBaseUrl, { size: this.inputSize })) as NsfwModelLike;
    this.model = model;
    const modelLoadMs = now() - t0;
    throwIfAborted(signal);

    const warmupMs = await this.warmUp();

    const info: BackendInfo = {
      backend,
      requested: pref,
      fallbackReason,
      modelLoadMs: round2(modelLoadMs),
      warmupMs: round2(warmupMs),
      weightBytes: weightBytes.bytes,
      servedFromCache: weightBytes.fromCache,
    };
    this.initialised = { pref, info };
    return info;
  }

  /**
   * Walk the backend chain until one initialises, rather than trusting feature detection.
   *
   * `tf.setBackend` can resolve false, or resolve true and then fail on first use, on real
   * devices - a blocklisted GPU driver, a webview with WebGL disabled, memory pressure. The
   * only reliable test is to select it and see. Reporting *which* backend we ended up on (and
   * why) is a first-class output, because it is the single biggest determinant of the numbers
   * in the benchmarks doc.
   */
  private async selectBackend(
    tf: TfLike,
    pref: BackendPref
  ): Promise<{ backend: BackendId; fallbackReason?: string }> {
    const chain = backendChain(pref);
    const failures: string[] = [];

    for (const candidate of chain) {
      try {
        if (candidate === 'webgpu') await import('@tensorflow/tfjs-backend-webgpu');
        if (candidate === 'wasm') {
          const wasm = await import('@tensorflow/tfjs-backend-wasm');
          // The binaries are vendored as static assets by `scripts/fetch-models.mjs`. Without
          // this, tfjs tries to fetch them from a CDN - which would quietly violate the
          // "runs entirely locally, no external calls" requirement.
          wasm.setWasmPaths('/tfjs/');
        }
        const ok = await tf.setBackend(candidate);
        if (!ok) {
          failures.push(`${candidate}: setBackend returned false`);
          continue;
        }
        await tf.ready();
        if (tf.getBackend() !== candidate) {
          failures.push(`${candidate}: resolved to ${tf.getBackend()}`);
          continue;
        }
        return {
          backend: candidate,
          fallbackReason: failures.length ? failures.join('; ') : undefined,
        };
      } catch (err) {
        failures.push(`${candidate}: ${describeError(err)}`);
      }
    }

    // tfjs always has a CPU backend registered; if we get here something is deeply wrong, but
    // reporting whatever it settled on beats throwing.
    await tf.ready();
    return {
      backend: (tf.getBackend() as BackendId) ?? 'cpu',
      fallbackReason: failures.join('; ') || 'no requested backend was usable',
    };
  }

  /**
   * A second warm-up on a real bitmap.
   *
   * nsfwjs already warms the model graph, but not the `fromPixels` upload path, which on WebGL
   * compiles its own shader program on first use. Without this the first user-visible frame
   * absorbs that compile and reads as a 200 ms+ outlier - which would then be reported as our
   * per-frame latency, and would be a lie.
   */
  private async warmUp(): Promise<number> {
    if (!this.tf || !this.model) return 0;
    const size = this.inputSize;

    // Built from ImageData rather than a canvas. `ImageData` exists in every worker context,
    // whereas `OffscreenCanvas` does not — it is absent in WebKit, where an unguarded
    // `new OffscreenCanvas()` here took down the whole app before a single frame was classified.
    // Mid-grey rather than black: some backends special-case all-zero textures.
    let bitmap: ImageBitmap;
    try {
      const pixels = new ImageData(size, size);
      pixels.data.fill(128);
      // Alpha must be opaque, which `fill` has just overwritten with 128.
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
      bitmap = await createImageBitmap(pixels);
    } catch {
      // Cannot build a warm-up frame here; the model graph was already warmed by nsfwjs's own
      // load-time predict, so this is a lost optimisation rather than a failure.
      return 0;
    }

    const t0 = now();
    try {
      await this.classify(bitmap);
    } catch {
      // A warm-up failure is not fatal; the real classify call will surface it properly.
    } finally {
      bitmap.close();
    }
    return now() - t0;
  }

  async classify(bitmap: ImageBitmap): Promise<ClassScores> {
    if (this.disposed) throw new Error('classifier has been disposed');
    const tf = this.tf;
    const model = this.model;
    if (!tf || !model) throw new Error('classifier used before init()');

    // Created outside any tf.tidy, so it is ours to dispose. nsfwjs's `infer` wraps its own
    // work in tidy(), which cleans up intermediates but NOT a tensor handed in from outside -
    // skipping this dispose leaks one tensor per frame, which over a 120-frame scan is a
    // visible GPU memory climb. The perf panel's tensor count is the canary for exactly this.
    const tensor = tf.browser.fromPixels(bitmap);
    try {
      const predictions = await model.classify(tensor, 5);
      return classScoresFromPredictions(predictions);
    } finally {
      tensor.dispose();
    }
  }

  memory(): { numTensors: number; numBytes: number } | undefined {
    return this.tf?.memory();
  }

  private disposeModel(): void {
    try {
      this.model?.dispose();
    } catch {
      /* already gone */
    }
    this.model = null;
    this.initialised = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeModel();
    this.tf = null;
  }
}

/**
 * Fetch the weight shard through the Cache-Storage-aware path so we can report cold vs. warm
 * load honestly in the benchmarks, and so a repeat scan does not re-download 2.62 MB.
 *
 * tfjs will fetch the same URL immediately afterwards and hit the HTTP cache, so this costs
 * one cache lookup rather than a second download.
 */
async function measureWeightFetch(baseUrl: string): Promise<{ bytes: number; fromCache: boolean }> {
  const url = new URL('group1-shard1of1', new URL(baseUrl, self.location.href)).href;
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('vcd-model-v1');
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        return { bytes: buf.byteLength, fromCache: true };
      }
      const res = await fetch(url);
      if (res.ok) {
        await cache.put(url, res.clone());
        const buf = await res.arrayBuffer();
        return { bytes: buf.byteLength, fromCache: false };
      }
    }
  } catch {
    // Cache Storage is unavailable in some contexts (private mode, no secure origin).
    // Not being able to measure the fetch is not a reason to fail the scan.
  }
  return { bytes: 0, fromCache: false };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round2 = (n: number): number => Math.round(n * 100) / 100;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('scan cancelled', 'AbortError');
}
