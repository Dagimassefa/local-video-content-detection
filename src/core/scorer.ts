import { ALL_CLASSES, type Policy } from './config';
import { NSFW_CLASS_NAMES, type ClassScores, type NsfwClassName } from './types';

/**
 * Turning five class probabilities into one number.
 *
 * Kept as a tiny pure module because this is where a reviewer should be able to see - in one
 * screen - exactly how a model output becomes a product decision, and because it makes the
 * behaviour unit-testable without a browser or a GPU.
 */

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Policy-weighted unsafe score for a single frame, in [0, 1].
 *
 * The inputs are a softmax over five mutually exclusive classes, so a weighted sum with
 * weights in [0, 1] is already bounded by 1 - no rescaling needed, and the result keeps a
 * readable meaning: "probability mass sitting on classes this policy cares about".
 */
export function frameScore(classes: ClassScores, policy: Policy): number {
  let total = 0;
  for (const name of ALL_CLASSES) {
    total += (classes[name] ?? 0) * policy.weights[name];
  }
  return clamp01(total);
}

/** Build a {@link ClassScores} from the model's raw output vector, in head order. */
export function classScoresFromVector(vector: ArrayLike<number>): ClassScores {
  if (vector.length !== NSFW_CLASS_NAMES.length) {
    throw new Error(
      `expected ${NSFW_CLASS_NAMES.length} class probabilities, received ${vector.length}`
    );
  }
  const out = {} as ClassScores;
  for (let i = 0; i < NSFW_CLASS_NAMES.length; i++) {
    out[NSFW_CLASS_NAMES[i]] = vector[i];
  }
  return out;
}

/**
 * nsfwjs `classify()` returns `[{className, probability}]` sorted by probability, so it must
 * be re-keyed rather than read positionally.
 */
export function classScoresFromPredictions(
  predictions: ReadonlyArray<{ className: string; probability: number }>
): ClassScores {
  const out: ClassScores = { Drawing: 0, Hentai: 0, Neutral: 0, Porn: 0, Sexy: 0 };
  for (const p of predictions) {
    if (p.className in out) out[p.className as NsfwClassName] = p.probability;
  }
  return out;
}

/** Highest-probability class, for display. Ties resolve to head order for determinism. */
export function dominantClass(classes: ClassScores): NsfwClassName {
  let best: NsfwClassName = 'Neutral';
  let bestP = -1;
  for (const name of ALL_CLASSES) {
    const p = classes[name] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = name;
    }
  }
  return best;
}

/**
 * Averaging two crops of the same frame (`multiCrop`): take the MAX per class, not the mean.
 *
 * A crop that misses the content produces a confidently-Neutral distribution, and averaging
 * that against a confidently-Porn one lands both below threshold - the exact failure mode
 * multi-crop exists to prevent. Max preserves "something in this frame is unsafe", which is
 * the question being asked.
 */
export function mergeCropScores(crops: ReadonlyArray<ClassScores>): ClassScores {
  if (crops.length === 0) throw new Error('mergeCropScores requires at least one crop');
  const out: ClassScores = { Drawing: 0, Hentai: 0, Neutral: 0, Porn: 0, Sexy: 0 };
  for (const name of ALL_CLASSES) {
    let max = 0;
    for (const crop of crops) max = Math.max(max, crop[name] ?? 0);
    out[name] = max;
  }
  return out;
}
