import type { ScanBudget } from './config';

/**
 * Adaptive latency governor.
 *
 * The device tier guessed at startup from core count and GPU presence is a weak signal - there
 * is no reliable way to read a phone's real inference throughput off the web platform. So rather
 * than trusting the guess, measure: once enough frames have gone through, compare observed
 * latency against the target and shrink the budget if we are over.
 *
 * This is also the thermal-throttling defence. A phone that starts fast and slows after thirty
 * seconds of sustained GPU load trips this mid-scan and quietly reduces its own ambitions, which
 * is far better than continuing to schedule work it can no longer do smoothly.
 *
 * ---
 *
 * **This is a pure function of the ORIGINAL budget, deliberately.**
 *
 * The first version mutated the live budget in place on every classified frame - and since it ran
 * once per frame, a device measuring 1.66x over target had its budget multiplied by 1.66 *again*
 * on every subsequent frame. After ten frames `minSampleGapMs` had compounded from 250 ms to
 * roughly 40 seconds and `maxFrames` had collapsed to its floor, so refinement had no interval
 * wide enough to bisect and the scan reported `complete` after only the survey. The adaptive half
 * of the algorithm was silently dead, and the stop reason was actively misleading about it.
 *
 * Recomputing from the original values makes the function idempotent: calling it every frame
 * converges on one answer instead of diverging. Found by `npm run bench`, not by reading the
 * code - which is the argument for having the harness at all.
 */

/** Ignore measurements until the histogram has enough samples to mean anything. */
const MIN_SAMPLES = 6;

/** Do not react until latency is meaningfully over target, not merely over it. */
const TOLERANCE = 1.5;

/** Never shrink by more than this, however slow the device turns out to be. */
const MAX_FACTOR = 3;

/** A scan that cannot sample at least this many frames is not worth running. */
const MIN_FRAMES_FLOOR = 16;

/** Refinement granularity is allowed to coarsen by at most this much. */
const MAX_GAP_MULTIPLIER = 2;

export interface GovernorInput {
  /** The budget as configured, never a previously-governed one. */
  original: ScanBudget;
  /** Observed median inference latency, ms. */
  observedP50Ms: number;
  /** How many inference measurements that median is based on. */
  sampleCount: number;
}

export interface GovernorResult {
  budget: ScanBudget;
  throttled: boolean;
  /** How far over target we measured, for display. 1 means at or under target. */
  factor: number;
}

/**
 * Widen the refinement floor when the source keeps handing back frames we already have.
 *
 * The hardware path can declare its temporal resolution up front (it has the keyframe index), but
 * the `<video>` path cannot: seek granularity depends on the container, the codec and the
 * browser's internal index, none of which are observable in advance. The benchmark showed it
 * duplicating 19 of 31 samples on a MediaRecorder WebM - well over half the frame budget spent
 * requesting timestamps that resolved to frames already scored.
 *
 * So measure it instead of predicting it. Every duplicate is direct evidence that the current
 * floor is finer than the source can resolve, so back off multiplicatively. Converges within a
 * few duplicates and never needs to know anything about the container.
 *
 * Capped relative to duration, because a floor approaching the length of the video would disable
 * refinement entirely - the same failure mode the latency governor above was fixed for.
 */
const DUPLICATE_TOLERANCE = 2;
const BACKOFF = 1.6;

export function resolutionFloorMs(input: {
  currentFloorMs: number;
  duplicateCount: number;
  durationMs: number;
}): number {
  const { currentFloorMs, duplicateCount, durationMs } = input;
  if (duplicateCount <= DUPLICATE_TOLERANCE) return currentFloorMs;

  const steps = duplicateCount - DUPLICATE_TOLERANCE;
  const widened = currentFloorMs * BACKOFF ** steps;
  // Never coarser than an eighth of the video: below that, refinement has nothing left to do.
  const ceiling = Math.max(currentFloorMs, durationMs / 8);
  return Math.round(Math.min(widened, ceiling));
}

export function governBudget({
  original,
  observedP50Ms,
  sampleCount,
}: GovernorInput): GovernorResult {
  if (sampleCount < MIN_SAMPLES || !(observedP50Ms > 0)) {
    return { budget: original, throttled: false, factor: 1 };
  }

  const overBy = observedP50Ms / Math.max(1, original.targetInferenceMs);
  if (overBy <= TOLERANCE) {
    return { budget: original, throttled: false, factor: 1 };
  }

  const factor = Math.min(MAX_FACTOR, overBy);
  return {
    budget: {
      ...original,
      // Fewer frames: the most direct lever on both time and battery.
      maxFrames: Math.max(MIN_FRAMES_FLOOR, Math.round(original.maxFrames / factor)),
      // And stop refining at a granularity this device cannot afford. Capped, because a floor
      // wide enough to exceed every interval would disable refinement altogether - which is the
      // failure this whole module is a fix for.
      minSampleGapMs: Math.round(original.minSampleGapMs * Math.min(MAX_GAP_MULTIPLIER, factor)),
    },
    throttled: true,
    factor,
  };
}
