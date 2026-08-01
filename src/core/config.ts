import type { ContentCategory } from './categories';
import type { ClassScores, DeviceTier, NsfwClassName } from './types';

/**
 * Policy profiles and scan budgets.
 *
 * The single most important thing this file encodes: "inappropriate" is a PRODUCT decision,
 * not a model output. The model gives us five probabilities; where the line falls between
 * "fine" and "restricted" differs enormously between a children's education app and an art
 * community. So thresholds are named, versioned, documented profiles rather than magic
 * numbers sprinkled through the pipeline - which is also what makes them remotely
 * configurable in production.
 */

export type PolicyProfileId = 'strict' | 'balanced' | 'permissive';

export interface Policy {
  id: PolicyProfileId;
  label: string;
  description: string;
  /**
   * Per-class contribution to a frame's unsafe score. Because the class probabilities are a
   * softmax (they sum to 1) and every weight is <= 1, the weighted sum is already in [0, 1] -
   * no extra normalisation, and the score stays interpretable.
   */
  weights: ClassScores;
  /**
   * How much each content category counts toward a frame's score, in [0, 1].
   *
   * Separate from `weights` (which is per NSFW *class*) because they answer different questions:
   * `weights` is "how explicit is this", `categoryWeights` is "how much does this kind of content
   * matter to us". A platform might screen for violence but weight it below sexual content, or the
   * reverse. Defaults to 1 for any category not listed, so a newly registered detector counts fully
   * unless a policy deliberately discounts it.
   */
  categoryWeights?: Partial<Record<ContentCategory, number>>;
  /** At or above this, a frame counts as flagged. */
  frameThreshold: number;
  /** A single frame this extreme is enough on its own - no corroboration needed. */
  singleFrameThreshold: number;
  /** Otherwise, how many independent flagged frames are required. */
  minFlaggedFrames: number;
  /**
   * Two flagged frames closer together than this count as ONE piece of evidence.
   * Stops a single half-second of content from satisfying an "N frames" rule by itself.
   */
  independenceGapMs: number;
}

const w = (
  drawing: number,
  hentai: number,
  neutral: number,
  porn: number,
  sexy: number
): ClassScores => ({ Drawing: drawing, Hentai: hentai, Neutral: neutral, Porn: porn, Sexy: sexy });

export const POLICIES: Record<PolicyProfileId, Policy> = {
  strict: {
    id: 'strict',
    label: 'Strict',
    description:
      "Child-safety posture. Suggestive content counts heavily and one frame is enough. Expect false positives on swimwear, medical and fine-art footage - that is the intended trade.",
    weights: w(0.05, 1, 0, 1, 0.7),
    frameThreshold: 0.3,
    singleFrameThreshold: 0.8,
    minFlaggedFrames: 1,
    independenceGapMs: 0,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description:
      'General-audience default. Explicit content is weighted fully, suggestive content only partially, and a verdict needs either two independent frames or one near-certain frame.',
    weights: w(0, 1, 0, 1, 0.35),
    frameThreshold: 0.55,
    singleFrameThreshold: 0.95,
    minFlaggedFrames: 2,
    independenceGapMs: 400,
  },
  permissive: {
    id: 'permissive',
    label: 'Permissive',
    description:
      'Adult platform posture: only explicit content is restricted, and it must persist. Minimises false positives at a real cost in recall.',
    weights: w(0, 0.9, 0, 1, 0.1),
    frameThreshold: 0.75,
    singleFrameThreshold: 0.98,
    minFlaggedFrames: 3,
    independenceGapMs: 1000,
  },
};

export const DEFAULT_POLICY_ID: PolicyProfileId = 'balanced';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface ScanBudget {
  /**
   * Phase A sample count. Fixed regardless of video length, which is precisely why
   * time-to-first-verdict does not grow with duration.
   */
  surveyFrames: number;
  /** Hard ceiling on frames run through the model across both phases. */
  maxFrames: number;
  /** Hard ceiling on wall-clock spent scanning. */
  maxWallClockMs: number;
  /** dHash Hamming distance below which a frame is treated as a duplicate. */
  dedupeHammingThreshold: number;
  /**
   * Target per-frame inference latency. The governor widens sampling when the rolling p50
   * exceeds this, so a weak device degrades its own thoroughness instead of janking.
   */
  targetInferenceMs: number;
  /** Refinement never bisects an interval narrower than twice this. */
  minSampleGapMs: number;
  /** How many decode requests may be outstanding at once. */
  decodeConcurrency: number;
}

export const BASE_BUDGET: ScanBudget = {
  surveyFrames: 16,
  maxFrames: 120,
  maxWallClockMs: 15_000,
  dedupeHammingThreshold: 6,
  targetInferenceMs: 45,
  minSampleGapMs: 250,
  decodeConcurrency: 2,
};

/**
 * Scale the budget to the device. A low-tier phone gets a smaller, faster, cheaper scan
 * rather than the same work stretched over a jankier ten seconds.
 */
export function budgetForTier(tier: DeviceTier, base: ScanBudget = BASE_BUDGET): ScanBudget {
  switch (tier) {
    case 'high':
      return { ...base, maxFrames: 160, maxWallClockMs: 20_000, decodeConcurrency: 3 };
    case 'medium':
      return { ...base };
    case 'low':
      return {
        ...base,
        surveyFrames: 10,
        maxFrames: 48,
        maxWallClockMs: 9_000,
        targetInferenceMs: 90,
        decodeConcurrency: 1,
      };
  }
}

/** Halve the work when the user has asked the OS/browser to conserve data or battery. */
export function applySaveData(budget: ScanBudget): ScanBudget {
  return {
    ...budget,
    surveyFrames: Math.max(6, Math.round(budget.surveyFrames * 0.6)),
    maxFrames: Math.max(16, Math.round(budget.maxFrames * 0.5)),
    maxWallClockMs: Math.round(budget.maxWallClockMs * 0.6),
  };
}

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/**
 * How a non-square video frame is mapped onto the model's square input.
 *
 * This is a genuine accuracy/compute trade with no free answer:
 *  - `squash`     - full field of view, mild aspect distortion. Default: never silently
 *                   discards part of the frame, and CNNs tolerate modest distortion.
 *  - `centerCrop` - undistorted, but throws away ~43% of a 16:9 frame horizontally, so
 *                   anything happening at the edges is invisible. A real recall risk.
 *  - `multiCrop`  - two overlapping crops for wide frames: no distortion, no lost edges,
 *                   2x the inference cost. Reserved for refining borderline frames.
 */
export type FitMode = 'squash' | 'centerCrop' | 'multiCrop';

export const MODEL_INPUT_SIZE = 224;

/** Where `scripts/fetch-models.mjs` vendors the weights. Served as static files, same-origin. */
export const MODEL_BASE_URL = '/models/mobilenet_v2/';

export interface ScanConfig {
  policyId: PolicyProfileId;
  budget: ScanBudget;
  fitMode: FitMode;
  backend: 'auto' | 'webgpu' | 'webgl' | 'wasm' | 'cpu';
  /** Stop as soon as the evidence is decisive, instead of spending the whole budget. */
  earlyExit: boolean;
  /** Skip inference on frames that are perceptually identical to a scored neighbour. */
  dedupe: boolean;
  /** Pause the scan while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Opt-in ONNX region detector for targeted (rather than whole-frame) blur. */
  regionDetection: boolean;
  /**
   * Opt-in violence detector (ViT-base on ONNX Runtime Web).
   *
   * Default OFF, and not merely for size. The only publicly available checkpoint fails
   * `npm run eval:violence`: its logits move 1.26 across inputs as different as pure black and pure
   * noise, and 16 portraits of people split 8/8. Because `combineCategoryScores` takes the WORST
   * category, a violence score idling near 0.65 would flag every frame and take the NSFW detector
   * down with it. The plumbing ships so a better checkpoint is a manifest swap; the model does not.
   */
  violenceDetection: boolean;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  policyId: DEFAULT_POLICY_ID,
  budget: BASE_BUDGET,
  fitMode: 'squash',
  backend: 'auto',
  earlyExit: true,
  dedupe: true,
  pauseWhenHidden: true,
  regionDetection: false,
  violenceDetection: false,
};

// ---------------------------------------------------------------------------
// Aggregation tuning
// ---------------------------------------------------------------------------

/**
 * How far in time a single sample is allowed to "vouch" for, in each direction.
 * Content is temporally correlated at scene scale, but not much beyond it - a frame at
 * 10:00 says essentially nothing about 10:30. This constant is what makes a 16-frame scan
 * of a two-hour film honestly report low coverage.
 */
export const SAMPLE_VOUCH_RADIUS_MS = 2_000;

/** Flagged samples closer than this merge into one restricted segment. */
export const SEGMENT_MERGE_GAP_MS = 2_000;

/**
 * Padding applied to each side of a restricted segment. Because sampling is sparse, the true
 * boundary of a scene lies somewhere between two samples; padding biases that uncertainty
 * toward restricting slightly too much rather than too little.
 */
export const SEGMENT_PAD_MS = 600;

/** Number of top-scoring frames averaged into the positive-verdict confidence. */
export const CONFIDENCE_TOP_K = 3;

/** We never claim certainty. Sampling alone makes 1.0 unjustifiable. */
export const MAX_CONFIDENCE = 0.99;

export const ALL_CLASSES: readonly NsfwClassName[] = [
  'Drawing',
  'Hentai',
  'Neutral',
  'Porn',
  'Sexy',
];
