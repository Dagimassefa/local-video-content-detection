import {
  CONFIDENCE_TOP_K,
  MAX_CONFIDENCE,
  SAMPLE_VOUCH_RADIUS_MS,
  SEGMENT_MERGE_GAP_MS,
  SEGMENT_PAD_MS,
  type Policy,
} from './config';
import { clamp01 } from './scorer';
import type { ContentCategory } from './categories';
import type { FrameScore, ScanVerdict, Segment } from './types';

/**
 * Temporal aggregation: many per-frame scores -> one verdict, one confidence, and a set of
 * restricted segments.
 *
 * This module is the answer to the most interesting question in the brief. Producing a
 * per-frame score is a library call; deciding what a sparse, unevenly-spaced, partially
 * deduplicated sequence of frame scores implies about a whole video is the actual engineering.
 */

export interface AggregateInput {
  frames: readonly FrameScore[];
  policy: Policy;
  durationMs: number;
}

export interface AggregateOutput {
  verdict: ScanVerdict;
  segments: Segment[];
  /** Frames at or above the policy's frame threshold. */
  flaggedCount: number;
  /** Flagged frames after collapsing ones closer together than `independenceGapMs`. */
  independentFlaggedCount: number;
  maxScore: number;
  topKMean: number;
  /** Fraction of the timeline the samples can reasonably vouch for, in [0, 1]. */
  coverage: number;
}

/**
 * How much of the timeline did we actually look at?
 *
 * Each sample vouches for a window around itself, bounded both by
 * {@link SAMPLE_VOUCH_RADIUS_MS} and by the half-distance to its neighbours (you cannot claim
 * to have covered ground that a neighbouring sample is closer to). Summing those windows and
 * dividing by duration gives an honest, monotone measure that behaves the way intuition says
 * it should: 16 samples fully cover a 30-second clip and barely scratch a two-hour film.
 *
 * This is the term that stops a negative verdict from claiming false certainty.
 */
export function temporalCoverage(
  timestampsMs: readonly number[],
  durationMs: number,
  radiusMs: number = SAMPLE_VOUCH_RADIUS_MS
): number {
  if (durationMs <= 0 || timestampsMs.length === 0) return 0;
  const ts = [...timestampsMs].sort((a, b) => a - b);

  let covered = 0;
  for (let i = 0; i < ts.length; i++) {
    const prev = i > 0 ? ts[i - 1] : null;
    const next = i < ts.length - 1 ? ts[i + 1] : null;

    // Reach backwards: limited by the radius, by the midpoint to the previous sample, and
    // by the start of the video.
    const back = Math.min(radiusMs, prev === null ? ts[i] : (ts[i] - prev) / 2);
    // And forwards, symmetrically.
    const forward = Math.min(radiusMs, next === null ? durationMs - ts[i] : (next - ts[i]) / 2);

    covered += Math.max(0, back) + Math.max(0, forward);
  }
  return clamp01(covered / durationMs);
}

/**
 * Collapse flagged frames into independent pieces of evidence.
 *
 * Two frames 100 ms apart are not two observations, they are one observation sampled twice -
 * and letting them satisfy a "two independent frames" rule would defeat the point of having
 * the rule. `independenceGapMs` is the minimum separation for a second look to count.
 */
function countIndependent(flaggedTimestamps: readonly number[], gapMs: number): number {
  if (flaggedTimestamps.length === 0) return 0;
  if (gapMs <= 0) return flaggedTimestamps.length;
  const ts = [...flaggedTimestamps].sort((a, b) => a - b);
  let count = 1;
  let anchor = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - anchor >= gapMs) {
      count++;
      anchor = ts[i];
    }
  }
  return count;
}

/** Mean of the K highest scores. Less jumpy than the single max, still sensitive to a real peak. */
function topKMean(scores: readonly number[], k: number): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const n = Math.min(k, sorted.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return sum / n;
}

/**
 * Confidence for a POSITIVE verdict.
 *
 * Deliberately not `max(frameScore)`. The max of a noisy per-frame signal is the single most
 * overconfident statistic available: one unlucky frame of skin-toned background reads as
 * 0.97 and would be reported as near-certainty. Instead:
 *
 *   - `strength`    - how far the top-K mean sits above the policy threshold, normalised so
 *                     "just barely over the line" maps to 0 and "saturated" maps to 1.
 *   - `persistence` - whether independent frames corroborate each other, or whether this
 *                     rests on a single observation.
 *
 * Both are needed: sustained mid-confidence detections and one blazing frame are different
 * epistemic situations that a single number should not conflate. Weighted 70/30 toward
 * strength, mapped into [0.5, 0.99] because a positive verdict we chose to emit is by
 * construction more likely than not.
 */
export function positiveConfidence(
  topK: number,
  independentFlagged: number,
  policy: Policy
): number {
  const headroom = Math.max(1e-6, 1 - policy.frameThreshold);
  const strength = clamp01((topK - policy.frameThreshold) / headroom);
  const persistence = clamp01(independentFlagged / Math.max(1, policy.minFlaggedFrames));
  const combined = 0.7 * strength + 0.3 * persistence;
  return Math.min(MAX_CONFIDENCE, 0.5 + 0.5 * clamp01(combined));
}

/**
 * Confidence for a NEGATIVE verdict.
 *
 * Two independent things make "this video is clean" more or less believable:
 *
 *   - `margin`   - how far the most suspicious frame we saw sat below the threshold. A video
 *                  whose peak frame scored 0.54 against a 0.55 threshold is a coin flip, not
 *                  a clean bill of health.
 *   - `coverage` - how much of the timeline we actually inspected. This is the term that
 *                  makes the output honest about sparse sampling, and it is why the same
 *                  clean 30-second clip and clean two-hour film do NOT get the same number.
 *
 * Coverage scales the achievable confidence between 0.70 (saw almost nothing, found nothing)
 * and 0.99 (looked everywhere, found nothing) rather than dragging it to 0.5: finding no
 * evidence in a handful of well-spread samples is weak evidence of absence, but it is not
 * *no* evidence.
 */
export function negativeConfidence(maxScore: number, coverage: number, policy: Policy): number {
  const margin = 1 - clamp01(maxScore / Math.max(1e-6, policy.frameThreshold));
  const coverageFactor = 0.4 + 0.6 * clamp01(coverage);
  return Math.min(MAX_CONFIDENCE, 0.5 + 0.5 * margin * coverageFactor);
}

/**
 * Merge flagged frames into padded, contiguous restricted segments.
 *
 * Padding is asymmetric in intent: because sampling is sparse, a scene's true boundary lies
 * somewhere between two samples, and this biases that uncertainty toward restricting slightly
 * too much rather than letting flagged content paint unblurred.
 */
export function buildSegments(
  frames: readonly FrameScore[],
  policy: Policy,
  durationMs: number,
  mergeGapMs: number = SEGMENT_MERGE_GAP_MS,
  padMs: number = SEGMENT_PAD_MS
): Segment[] {
  const flagged = frames
    .filter((f) => f.score >= policy.frameThreshold)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (flagged.length === 0) return [];

  const groups: FrameScore[][] = [[flagged[0]]];
  for (let i = 1; i < flagged.length; i++) {
    const group = groups[groups.length - 1];
    if (flagged[i].tsMs - group[group.length - 1].tsMs <= mergeGapMs) group.push(flagged[i]);
    else groups.push([flagged[i]]);
  }

  const limit = durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
  return groups.map((group) => {
    let peak = group[0];
    for (const f of group) if (f.score > peak.score) peak = f;
    return {
      startMs: Math.max(0, group[0].tsMs - padMs),
      endMs: Math.min(limit, group[group.length - 1].tsMs + padMs),
      peakScore: peak.score,
      peakTsMs: peak.tsMs,
      thumbnail: peak.thumbnail,
    };
  });
}

/**
 * The full aggregation step. Pure, deterministic, and safe to call on every partial result -
 * which is what lets the UI stream a live-refining verdict rather than waiting for the scan
 * to finish.
 */
export function aggregate({ frames, policy, durationMs }: AggregateInput): AggregateOutput {
  const scores = frames.map((f) => f.score);
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const topK = topKMean(scores, CONFIDENCE_TOP_K);

  const flaggedTs = frames.filter((f) => f.score >= policy.frameThreshold).map((f) => f.tsMs);
  const independentFlagged = countIndependent(flaggedTs, policy.independenceGapMs);

  const coverage = temporalCoverage(
    frames.map((f) => f.tsMs),
    durationMs
  );

  // Two independent routes to a positive verdict:
  //   1. enough corroborating frames over the threshold, or
  //   2. one frame so extreme that corroboration is not required.
  // Both are needed. (1) alone misses a brief but unmistakable shot; (2) alone would let a
  // single false positive condemn an entire video.
  const byPersistence = independentFlagged >= policy.minFlaggedFrames;
  const bySingleFrame = maxScore >= policy.singleFrameThreshold;
  const positive = frames.length > 0 && (byPersistence || bySingleFrame);

  const confidence = positive
    ? positiveConfidence(topK, independentFlagged, policy)
    : negativeConfidence(maxScore, coverage, policy);

  return {
    verdict: {
      contains_inappropriate_content: positive,
      // Rounded to two decimals: the calibration does not justify more precision than that,
      // and it matches the shape given in the brief.
      confidence: Math.round(confidence * 100) / 100,
    },
    segments: buildSegments(frames, policy, durationMs),
    flaggedCount: flaggedTs.length,
    independentFlaggedCount: independentFlagged,
    maxScore,
    topKMean: topK,
    coverage,
  };
}

/**
 * Should we stop early?
 *
 * Once the evidence is decisive, further sampling changes the answer only marginally while
 * continuing to cost battery and heat - the resource that matters most on the target
 * platform. Requires either a genuinely saturated single frame or corroborated evidence
 * comfortably above the bar, so this never short-circuits a borderline case where the extra
 * samples would actually inform the verdict.
 */
export function shouldEarlyExit(result: AggregateOutput, policy: Policy): boolean {
  if (!result.verdict.contains_inappropriate_content) return false;
  const saturated = result.maxScore >= Math.max(policy.singleFrameThreshold, 0.98);
  const corroborated =
    result.independentFlaggedCount >= Math.max(2, policy.minFlaggedFrames) &&
    result.topKMean >= policy.frameThreshold + 0.2;
  return saturated || corroborated;
}

/**
 * Peak score per category across the whole scan, and which one drove the verdict.
 *
 * With one detector this is a curiosity. With several it is the answer to "why was this flagged" -
 * because `combineCategoryScores` collapses to the worst category per frame, the verdict can be
 * driven by a category the viewer is not thinking about. Surfacing the breakdown is what makes a
 * multi-detector verdict explicable rather than an opaque number.
 *
 * It is also what makes a bad detector visible instead of merely suspicious: a category sitting at
 * 0.69 on obviously benign footage is a fact you can point at.
 */
export function peakCategoryScores(frames: readonly FrameScore[]): {
  peaks: Array<{ category: ContentCategory; peak: number }>;
  driver: ContentCategory | null;
} {
  const peaks = new Map<ContentCategory, number>();
  for (const frame of frames) {
    for (const [category, value] of Object.entries(frame.categories ?? {}) as Array<
      [ContentCategory, number]
    >) {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      peaks.set(category, Math.max(peaks.get(category) ?? 0, value));
    }
  }
  const sorted = [...peaks.entries()]
    .map(([category, peak]) => ({ category, peak }))
    // Descending, ties broken by name so the order is stable between renders.
    .sort((a, b) => b.peak - a.peak || a.category.localeCompare(b.category));

  return { peaks: sorted, driver: sorted[0]?.category ?? null };
}
