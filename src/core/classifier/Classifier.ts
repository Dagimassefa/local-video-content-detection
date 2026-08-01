import type { BackendInfo, BackendPref, ClassScores } from '../types';

/**
 * The seam between the pipeline and whatever is doing the inference.
 *
 * This interface is the single most important piece of risk management in the codebase, for a
 * reason that is easy to miss: **TensorFlow.js is effectively in maintenance mode.** As of
 * mid-2026 the published version is still 4.22.0, while ONNX Runtime Web is at 1.27 and moving
 * fast (better WebGPU kernels, cleaner int8 quantisation, a credible WebNN path). Yet TFJS is
 * where the best ready-to-use, mobile-sized NSFW model actually lives.
 *
 * Betting the whole pipeline on a stagnating runtime would be careless; rewriting a proven
 * model from scratch to avoid it would be wasteful. So: ship the model that works today,
 * behind an interface narrow enough that swapping the runtime touches exactly one file and
 * nothing else in the system needs to know.
 *
 * The interface is deliberately minimal - it takes an `ImageBitmap` and returns five numbers.
 * No tensors, no runtime types, no framework leakage. That is also precisely the shape a
 * native mobile implementation would have (Core ML / NNAPI-TFLite behind the same call), which
 * is what makes the port a genuine possibility rather than a slide in a deck.
 */
export interface Classifier {
  readonly id: string;
  readonly inputSize: number;

  /** Load weights and warm up. Resolves with what actually happened, not what was requested. */
  init(pref: BackendPref, signal?: AbortSignal): Promise<BackendInfo>;

  /**
   * Classify one frame, already downscaled to {@link inputSize}.
   *
   * The caller retains ownership of the bitmap and is responsible for closing it - the
   * classifier must not consume it, because the same bitmap is also used to produce
   * thumbnails for flagged frames.
   */
  classify(bitmap: ImageBitmap): Promise<ClassScores>;

  /**
   * Localise unsafe regions, when the backend supports it.
   *
   * Optional on purpose. The classification model answers "is there something here", which is
   * what the verdict needs; region boxes only matter for *targeted* rather than whole-frame
   * blurring, and paying for a second model on every frame to get them would be a poor trade.
   * When present, this is called only on already-flagged frames.
   */
  detectRegions?(bitmap: ImageBitmap): Promise<DetectedRegion[]>;

  /** Free all GPU/WASM resources. Must be safe to call twice. */
  dispose(): void;

  /** Live resource accounting, for the leak canary in the perf panel. */
  memory?(): { numTensors: number; numBytes: number } | undefined;
}

/** Normalised box coordinates in [0, 1], relative to the frame. */
export interface DetectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  score: number;
}


export function backendChain(pref: BackendPref): Array<'webgpu' | 'webgl' | 'wasm' | 'cpu'> {
  const all = ['webgpu', 'webgl', 'wasm', 'cpu'] as const;
  if (pref === 'auto') return [...all];
  const idx = all.indexOf(pref as (typeof all)[number]);
  if (idx < 0) return [...all];
  return [all[idx], ...all.filter((_, i) => i > idx)];
}
