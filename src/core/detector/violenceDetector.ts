import type { ContentCategory } from '../categories';
import type { Policy } from '../config';
import { createCanvas2D } from '../frames/canvas';
import type { BackendInfo, BackendPref } from '../types';
import type { Detector, DetectorResult } from './Detector';

/**
 * Violence detection: a ViT-base classifier running on ONNX Runtime Web.
 *
 * ## Why this exists and why it is opt-in
 *
 * There is no MobileNet-class violence model published anywhere. Every option on Hugging Face is a
 * ViT-base at 327 MB fp32; 86.8 MB int8 is the smallest quantisation that runs reliably under
 * onnxruntime-web. That is **33x the 2.62 MB NSFW classifier**, and shipping it by default would take
 * the cold-start payload from 2.62 MB to ~89 MB and destroy the mobile story the rest of this project
 * is built around.
 *
 * So it is off by default, vendored only on `npm run models -- --violence`, and lazily loaded the first
 * time a scan runs with it enabled. Anyone who wants violence screening opts in and knowingly pays for
 * it. The honest framing is in `docs/02-model-selection.md`: this is a capability demonstration and a
 * desktop-viable feature, not something to ship to a phone as-is.
 *
 * ## Why it is a second RUNTIME, not just a second model
 *
 * This runs on ONNX Runtime Web while the NSFW detector runs on TensorFlow.js - two model families
 * (ViT vs MobileNet), two runtimes, one pipeline, composed through `Detector`. That is the strongest
 * available evidence that the capability seam is real rather than aspirational, and it exercises the
 * exact migration path `docs/02` describes for moving off TFJS.
 *
 * ## Preprocessing
 *
 * `ViTFeatureExtractor`: rescale to [0,1] then normalise with mean=std=0.5, giving [-1, 1]. Layout is
 * NCHW (1,3,224,224) - note this differs from tfjs's NHWC, which is a classic silent-corruption trap
 * if you copy the channel loop from one to the other.
 */

/** Where `scripts/fetch-models.mjs --violence` vendors the model. */
const MODEL_DIR = '/models/vit-violence/';
const INPUT_SIZE = 224;

interface OrtLike {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  env: { wasm: { wasmPaths?: string; numThreads?: number; simd?: boolean } };
}

interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | Int32Array }>>;
  release?(): Promise<void>;
}

export interface ViolenceManifest {
  labels: string[];
  violenceIndex: number;
  inputSize: number;
  normalize: { mean: number[]; std: number[] };
}

/**
 * Is the model vendored on this deployment?
 *
 * Checked before registering the detector, so the app degrades to NSFW-only rather than failing when
 * someone has not run the opt-in download. Returns the manifest so the label order and normalisation
 * come from the vendored artefact rather than being duplicated in code - if the model is ever swapped,
 * the manifest is the single source of truth.
 */
export async function loadViolenceManifest(
  baseUrl: string = MODEL_DIR
): Promise<ViolenceManifest | null> {
  try {
    const res = await fetch(new URL('manifest.json', new URL(baseUrl, self.location.href)).href);
    if (!res.ok) return null;
    const manifest = (await res.json()) as Partial<ViolenceManifest>;
    if (
      !Array.isArray(manifest.labels) ||
      typeof manifest.violenceIndex !== 'number' ||
      manifest.violenceIndex < 0 ||
      manifest.violenceIndex >= manifest.labels.length
    ) {
      return null;
    }
    return {
      labels: manifest.labels,
      violenceIndex: manifest.violenceIndex,
      inputSize: manifest.inputSize ?? INPUT_SIZE,
      normalize: manifest.normalize ?? { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    };
  } catch {
    return null;
  }
}

export class ViolenceDetector implements Detector {
  readonly id = 'vit-violence-onnx';
  readonly categories: readonly ContentCategory[] = ['violence'];

  private session: OrtSession | null = null;
  private ort: OrtLike | null = null;
  private disposed = false;
  private reusableInput: Float32Array | null = null;

  constructor(
    private readonly manifest: ViolenceManifest,
    private readonly baseUrl: string = MODEL_DIR
  ) {}

  async init(pref: BackendPref): Promise<BackendInfo> {
    const t0 = now();

    // The `/wasm` subpath, NOT the default entry.
    //
    // The default `onnxruntime-web` entry is the JSEP build, which reaches for
    // `ort-wasm-simd-threaded.jsep.mjs` and its 26 MB `.wasm` sibling even when only the WASM
    // provider is requested. Since those are deliberately not vendored, loading it fails with
    // "no available backend found" - which is what happened the first time the UI toggle was
    // actually exercised. The `/wasm` build uses the plain binaries we do ship.
    //
    // Dynamic import either way: a user who never enables violence detection never downloads it.
    const ort = (await import('onnxruntime-web/wasm')) as unknown as OrtLike;
    this.ort = ort;

    // Same-origin WASM binaries, vendored alongside everything else. Without this, ORT fetches its
    // runtime from a CDN - which would silently break the "no external calls" guarantee that
    // `npm run verify` asserts, and it would do so only when this optional feature was enabled.
    ort.env.wasm.wasmPaths = '/ort/';
    // Single-threaded: SharedArrayBuffer needs COEP, which we deliberately do not set because it
    // would break cross-origin video URLs. See vite.config.ts.
    ort.env.wasm.numThreads = 1;

    const modelUrl = new URL('model.onnx', new URL(this.baseUrl, self.location.href)).href;

    // WASM only. `scripts/fetch-models.mjs` deliberately does not vendor the 26 MB JSEP binary that
    // the WebGPU provider needs, because this model is disabled by default and failed its evaluation
    // - spending 26 MB to accelerate something nobody should run is the wrong trade. Re-adding it is
    // a one-line change in both places if a checkpoint ever passes.
    void pref;
    const providers = ['wasm'];
    let session: OrtSession | null = null;
    let fallbackReason: string | undefined;

    for (const provider of providers) {
      try {
        session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
        });
        break;
      } catch (err) {
        fallbackReason = `${provider}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!session) {
      throw new Error(`violence model failed to load: ${fallbackReason ?? 'unknown'}`);
    }
    this.session = session;

    const modelLoadMs = now() - t0;
    const warmT0 = now();
    await this.warmUp();

    return {
      backend: 'wasm',
      requested: pref,
      fallbackReason,
      modelLoadMs: round2(modelLoadMs),
      warmupMs: round2(now() - warmT0),
      weightBytes: 0,
      servedFromCache: false,
    };
  }

  /** One pass on a grey frame so the first real frame is not paying for graph setup. */
  private async warmUp(): Promise<void> {
    if (!this.session || !this.ort) return;
    try {
      const size = this.manifest.inputSize;
      const input = new Float32Array(3 * size * size).fill(0);
      await this.runTensor(input);
    } catch {
      // Warm-up is an optimisation; a failure here surfaces properly on the first real frame.
    }
  }

  async score(bitmap: ImageBitmap, policy: Policy): Promise<DetectorResult> {
    void policy;
    if (this.disposed || !this.session) return { categories: {} };
    const input = this.toTensorData(bitmap);
    if (!input) return { categories: {} };
    const logits = await this.runTensor(input);
    if (!logits) return { categories: {} };

    const probs = softmax(logits);
    const violence = probs[this.manifest.violenceIndex] ?? 0;
    return { categories: { violence } };
  }

  private async runTensor(input: Float32Array): Promise<Float32Array | null> {
    const ort = this.ort;
    const session = this.session;
    if (!ort || !session) return null;
    const size = this.manifest.inputSize;
    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    const feeds: Record<string, unknown> = { [session.inputNames[0]]: tensor };
    const output = await session.run(feeds);
    const first = output[session.outputNames[0]];
    return first ? (first.data as Float32Array) : null;
  }

  /**
   * ImageBitmap -> normalised NCHW Float32Array.
   *
   * **NCHW, not NHWC.** tfjs works in NHWC and ONNX vision models are almost always NCHW; transposing
   * wrongly here does not throw, it just feeds the network scrambled colour planes and produces
   * confident nonsense. Worth the explicit loop over a clever one-liner.
   */
  private toTensorData(bitmap: ImageBitmap): Float32Array | null {
    const size = this.manifest.inputSize;
    const surface = createCanvas2D(size, size, { willReadFrequently: true });
    if (!surface) return null;

    surface.ctx.drawImage(bitmap, 0, 0, size, size);
    const { data } = surface.ctx.getImageData(0, 0, size, size);

    const pixels = size * size;
    if (!this.reusableInput || this.reusableInput.length !== pixels * 3) {
      // Reused across frames: allocating a 600 KB Float32Array per frame would churn the heap for
      // no reason.
      this.reusableInput = new Float32Array(pixels * 3);
    }
    const out = this.reusableInput;
    const { mean, std } = this.manifest.normalize;

    for (let i = 0; i < pixels; i++) {
      const src = i * 4;
      out[i] = (data[src] / 255 - mean[0]) / std[0];
      out[pixels + i] = (data[src + 1] / 255 - mean[1]) / std[1];
      out[pixels * 2 + i] = (data[src + 2] / 255 - mean[2]) / std[2];
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.session?.release?.();
    this.session = null;
    this.ort = null;
    this.reusableInput = null;
  }
}

/** Numerically stable softmax - subtracting the max prevents `exp` overflowing on large logits. */
export function softmax(logits: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  const out = new Array<number>(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum || 1;
  return out;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round2 = (n: number): number => Math.round(n * 100) / 100;
