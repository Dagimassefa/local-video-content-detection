import type { CategoryScores, ContentCategory } from './categories';

/**
 * Shared vocabulary for the detection engine.
 *
 * `src/core` is deliberately free of React and of any DOM assumption outside
 * `core/frames/*`. That is what makes the interesting half of this codebase portable to a
 * React Native / Capacitor host later: the sampler, scorer, aggregator and budget governor
 * move across untouched, and only `FrameSource` + `Classifier` need new implementations.
 */

/**
 * Output order of the NSFWJS MobileNetV2 head. Fixed by the model - do not reorder.
 * Mirrors `NSFW_CLASSES` in nsfwjs and `classes` in `public/models/mobilenet_v2/manifest.json`.
 */
export const NSFW_CLASS_NAMES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'] as const;

export type NsfwClassName = (typeof NSFW_CLASS_NAMES)[number];

/** A softmax distribution over {@link NSFW_CLASS_NAMES}; sums to ~1. */
export type ClassScores = Record<NsfwClassName, number>;

// ---------------------------------------------------------------------------
// Runtime / device
// ---------------------------------------------------------------------------

export type BackendId = 'webgpu' | 'webgl' | 'wasm' | 'cpu';
export type BackendPref = BackendId | 'auto';

/** Coarse device class used to scale scan budgets. */
export type DeviceTier = 'high' | 'medium' | 'low';

export interface BackendInfo {
  /** The backend tfjs actually resolved to, which may not be what we asked for. */
  backend: BackendId;
  requested: BackendPref;
  /** Populated when the preferred backend was unavailable. */
  fallbackReason?: string;
  modelLoadMs: number;
  warmupMs: number;
  /** Bytes of weights fetched (0 when served from the HTTP/Cache-Storage cache). */
  weightBytes: number;
  servedFromCache: boolean;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type FrameSourceKind = 'webcodecs' | 'video-element';

export interface VideoMeta {
  durationMs: number;
  width: number;
  height: number;
  /**
   * Decode-order keyframe timestamps, when the container could be demuxed.
   * Sampling on keyframes is near-free (no dependent-frame decode) and they correlate
   * with scene cuts, which makes them the highest-information frames per unit of compute.
   */
  keyframeTimesMs?: number[];
  codec?: string;
  kind: FrameSourceKind;
  /**
   * The finest interval at which this source can deliver DISTINCT frames.
   *
   * Not a formality. The hardware path bounds how far it will walk past a keyframe, so on a file
   * with a long GOP its real resolution is the keyframe spacing, not the frame duration. Without
   * this, refinement happily bisects down to 250 ms, gets the same keyframe back over and over,
   * and burns frame budget on requests that can only ever return a frame already scored - which
   * the benchmark showed doing exactly that (more duplicates than distinct frames).
   *
   * The sampler uses it as a floor, so effort goes where the source can actually resolve detail.
   */
  temporalResolutionMs?: number;
}

/** A frame that has been decoded and downscaled to the model's input size. */
export interface SampledFrame {
  tsMs: number;
  bitmap: ImageBitmap;
  /** 64-bit perceptual hash as 16 hex chars, computed at decode time (see `core/dhash.ts`). */
  hash: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface FrameScore {
  tsMs: number;
  /** Policy-weighted unsafe score in [0, 1] - the worst category. See `core/detector/Detector.ts`. */
  score: number;
  classes: ClassScores;
  /** Per-category breakdown. Absent keys were not screened. */
  categories?: CategoryScores;
  /**
   * True when inference was SKIPPED because this frame was perceptually identical to an
   * already-classified neighbour, and the score was inherited from it.
   */
  inherited: boolean;
  hash: string;
  /** Small WebP data URL. Only produced for flagged frames, to bound cost. */
  thumbnail?: string;
}

/** A contiguous stretch of the timeline that should be restricted. */
export interface Segment {
  startMs: number;
  endMs: number;
  peakScore: number;
  peakTsMs: number;
  thumbnail?: string;
}

// ---------------------------------------------------------------------------
// Verdict - the contract the challenge specifies
// ---------------------------------------------------------------------------

/**
 * THE deliverable payload, exactly as specified. Nothing else belongs in this object;
 * everything else the app knows lives in {@link ScanResult} as diagnostics.
 */
export interface ScanVerdict {
  contains_inappropriate_content: boolean;
  confidence: number;
}

export type ScanPhase =
  | 'idle'
  | 'loading-model'
  | 'probing'
  | 'survey'
  | 'refine'
  | 'done'
  | 'cancelled'
  | 'error';

export type StopReason =
  | 'complete'
  | 'early-exit'
  | 'frame-budget'
  | 'time-budget'
  | 'cancelled'
  | 'error';

export interface ScanStats {
  durationMs: number;
  /** Frames handed to the pipeline. */
  sampledFrames: number;
  /** Frames that actually ran through the model. */
  inferredFrames: number;
  /** Frames skipped by perceptual dedupe. */
  dedupedFrames: number;
  /** Frames the source could not produce (seek failures, decode gaps). */
  failedFrames: number;
  /**
   * Distinct requests that resolved to a frame already recorded, and were therefore discarded.
   * High counts mean the source's temporal resolution is coarser than the sampler is asking for -
   * a long keyframe interval, or a container that seeks poorly.
   */
  duplicateFrames: number;
  /**
   * Fraction of the timeline our samples can reasonably vouch for, in [0, 1].
   * Drives how much confidence a *negative* verdict is allowed to claim.
   */
  coverage: number;
  elapsedMs: number;
  /** Wall-clock to the first (preliminary) verdict - the responsiveness number that matters. */
  timeToFirstVerdictMs: number | null;
  source: FrameSourceKind;
  backend: BackendId | null;
  stopReason: StopReason | null;
  /**
   * Which content categories were actually screened, and which were not.
   *
   * Part of the diagnostics rather than prose, so a caller can tell programmatically that a negative
   * verdict means "no sexual content found" rather than "nothing wrong with this video". A narrowing
   * documented only in a README gets lost the moment someone integrates against the JSON; one carried
   * in the payload cannot be. See `core/categories.ts`.
   */
  screenedCategories: ContentCategory[];
  unscreenedCategories: ContentCategory[];
}

export interface ScanResult {
  verdict: ScanVerdict;
  frames: FrameScore[];
  segments: Segment[];
  stats: ScanStats;
  phase: ScanPhase;
  /** False for the streaming preliminary results; true for the last one. */
  finalized: boolean;
}

// ---------------------------------------------------------------------------
// Progress events (worker -> UI)
// ---------------------------------------------------------------------------

export type ScanEvent =
  | { type: 'phase'; phase: ScanPhase; detail?: string }
  | { type: 'model-ready'; info: BackendInfo }
  | { type: 'meta'; meta: VideoMeta }
  | { type: 'progress'; result: ScanResult; perf: PerfSnapshot }
  | { type: 'done'; result: ScanResult; perf: PerfSnapshot }
  | { type: 'error'; message: string; kind: ScanErrorKind };

/** Distinguishable failure modes, so the UI can say something actionable. */
export type ScanErrorKind =
  | 'cors'
  | 'unsupported-codec'
  | 'decode'
  | 'model-load'
  | 'no-frames'
  | 'unknown';

export interface HistogramSnapshot {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface PerfSnapshot {
  timers: Record<string, HistogramSnapshot>;
  /** tfjs tensor accounting - the leak canary. */
  tensors?: { numTensors: number; numBytes: number };
  /** Samples per second, end to end. */
  throughput: number;
  /**
   * Event counters: deduped frames, duplicate timestamps, and - importantly -
   * `governor.throttled`, which is how a benchmark run can PROVE the latency governor actually
   * fired on a slow device rather than merely asserting that it would.
   */
  counters: Record<string, number>;
}
