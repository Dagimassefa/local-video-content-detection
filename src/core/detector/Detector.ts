import type { CategoryScores, ContentCategory } from '../categories';
import type { Policy } from '../config';
import { clamp01 } from '../scorer';
import type { BackendInfo, BackendPref, ClassScores } from '../types';

/**
 * A detector screens a frame for one or more {@link ContentCategory}s.
 *
 * This sits one level above `Classifier`. The distinction matters:
 *
 *   - `Classifier` is a *model runtime* boundary — "run this network, give me its outputs". It exists so
 *     TensorFlow.js can be swapped for ONNX Runtime Web without touching anything else.
 *   - `Detector` is a *capability* boundary — "screen this frame for these categories". It exists so a
 *     new content category can be added by registering a component, rather than by threading a second
 *     model through the pipeline, the scorer, the aggregator and the UI.
 *
 * Keeping them separate is what makes "we screen sexual content today, violence is a registration away"
 * a structural claim rather than an aspiration.
 */
export interface Detector {
  readonly id: string;
  /** Categories this detector produces scores for. */
  readonly categories: readonly ContentCategory[];

  init(pref: BackendPref, signal?: AbortSignal): Promise<BackendInfo>;

  /**
   * Score one frame, already downscaled to the model's input size.
   *
   * The caller retains ownership of the bitmap and must close it — detectors must not consume it,
   * because with several detectors registered the same bitmap is passed to each in turn.
   */
  score(bitmap: ImageBitmap, policy: Policy): Promise<DetectorResult>;

  dispose(): void;

  memory?(): { numTensors: number; numBytes: number } | undefined;
}

export interface DetectorResult {
  categories: CategoryScores;
  /**
   * Optional model-native detail, retained for display and debugging. For the NSFW detector this is
   * the raw five-class distribution, which the timeline exposes on hover — being able to see *why* a
   * frame scored as it did is what makes a false positive diagnosable rather than mysterious.
   */
  detail?: ClassScores;
}

/**
 * Collapse per-category scores into the single frame score the sampler and aggregator work with.
 *
 * **Max, not sum or mean.** The question being answered is "is there anything inappropriate in this
 * frame", so a frame that is confidently violent and confidently non-sexual is exactly as unsafe as one
 * that is confidently sexual. Summing would let two mild, unrelated signals manufacture a strong one;
 * averaging would let a confidently-clean category dilute a genuine detection from another — which is
 * the same mistake `mergeCropScores` avoids for crops, for the same reason.
 *
 * Absent categories contribute nothing at all. A category that was never screened must not be able to
 * lower a score, and must never be treated as "screened and clean".
 */
export function combineCategoryScores(scores: CategoryScores, policy: Policy): number {
  let worst = 0;
  for (const [category, value] of Object.entries(scores) as Array<[ContentCategory, number]>) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    const weight = policy.categoryWeights?.[category] ?? 1;
    worst = Math.max(worst, clamp01(value) * clamp01(weight));
  }
  return clamp01(worst);
}

/** Merge several detectors' outputs, keeping the highest score seen for each category. */
export function mergeDetectorResults(results: readonly DetectorResult[]): DetectorResult {
  const categories: CategoryScores = {};
  let detail: ClassScores | undefined;
  for (const result of results) {
    for (const [category, value] of Object.entries(result.categories) as Array<
      [ContentCategory, number]
    >) {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      const current = categories[category];
      categories[category] = current === undefined ? value : Math.max(current, value);
    }
    // First detector to offer native detail wins; it is display-only.
    if (!detail && result.detail) detail = result.detail;
  }
  return { categories, detail };
}
