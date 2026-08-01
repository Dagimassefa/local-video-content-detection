import type { ScanBudget } from './config';

/**
 * Adaptive frame sampling - the central design decision in this prototype.
 *
 * The obvious approach is "decode at 1 fps, classify everything, report at the end". It is
 * also wrong for this problem in three separate ways:
 *
 *   1. Cost grows linearly with duration. A 90-minute video is 5,400 inferences. On a phone
 *      that is minutes of sustained GPU load, thermal throttling, and measurable battery.
 *   2. The user learns nothing until it finishes. Time-to-answer scales with the input, which
 *      is exactly the property a UI must not have.
 *   3. It spends the same effort everywhere, even though the interesting parts of a video are
 *      almost never uniformly distributed.
 *
 * So instead this is an *anytime* algorithm: it always has a current best answer, and every
 * additional sample refines it. Two phases:
 *
 *   Phase A - SURVEY. A fixed number of samples spread across the whole timeline. Fixed count
 *             means constant cost, which means time-to-first-verdict is independent of
 *             duration: a 30-second clip and a two-hour film both produce a preliminary
 *             verdict in about the same time.
 *
 *   Phase B - REFINE. Repeatedly bisect the interval that is most worth looking at, scored by
 *             how suspicious its endpoints are and how wide it is. Effort concentrates where
 *             there is signal; long uniform stretches are never re-examined. Because it is
 *             driven by a priority queue rather than a fixed schedule, it can be stopped at
 *             any moment - on a frame budget, a time budget, a decisive verdict, or the user
 *             hitting cancel - and the answer is still coherent.
 *
 * The class is pure and deterministic: no clock, no I/O, no randomness. It takes observations
 * and hands back timestamps, which is what makes the sampling policy unit-testable without a
 * browser, a GPU, or a video file.
 */

export type SamplePhase = 'survey' | 'refine';

export interface SampleRequest {
  tsMs: number;
  phase: SamplePhase;
  /** True when the timestamp was snapped onto a container keyframe. */
  onKeyframe: boolean;
}

export interface SamplerOptions {
  durationMs: number;
  budget: ScanBudget;
  keyframeTimesMs?: readonly number[];
}

interface Interval {
  aMs: number;
  bMs: number;
  scoreA: number;
  scoreB: number;
  priority: number;
}

/**
 * Baseline priority given to every interval regardless of score.
 *
 * Without it, a video whose survey came back entirely clean would have priority 0 everywhere
 * and refinement would have no basis to choose - yet those are exactly the videos where we
 * still want to keep looking, just in the widest unexamined gaps. With it, priority degrades
 * gracefully into "bisect the biggest hole", which is the correct behaviour in the absence of
 * any signal.
 */
const BASE_PRIORITY = 0.15;

/** Max-heap on `priority`, ties broken by earlier `aMs` so runs are reproducible. */
class IntervalHeap {
  private readonly items: Interval[] = [];

  get size(): number {
    return this.items.length;
  }

  private static before(x: Interval, y: Interval): boolean {
    if (x.priority !== y.priority) return x.priority > y.priority;
    return x.aMs < y.aMs;
  }

  push(item: Interval): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (IntervalHeap.before(this.items[i], this.items[parent])) {
        [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
        i = parent;
      } else break;
    }
  }

  pop(): Interval | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.items.length && IntervalHeap.before(this.items[l], this.items[best])) best = l;
        if (r < this.items.length && IntervalHeap.before(this.items[r], this.items[best])) best = r;
        if (best === i) break;
        [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
        i = best;
      }
    }
    return top;
  }

  clear(): void {
    this.items.length = 0;
  }
}

export class AdaptiveSampler {
  private readonly durationMs: number;
  private readonly budget: ScanBudget;
  private readonly keyframes: number[];

  private readonly surveyQueue: SampleRequest[] = [];
  private readonly heap = new IntervalHeap();

  /** Every timestamp we have requested, to guarantee we never sample the same instant twice. */
  private readonly requested = new Set<number>();
  /** Observations, kept sorted by timestamp - the basis for building refinement intervals. */
  private readonly observations: Array<{ tsMs: number; score: number }> = [];
  /** Refinement midpoints in flight, so their children can be queued once they resolve. */
  private readonly inFlight = new Map<number, Interval>();

  private surveyPlanned = 0;
  private refineStarted = false;

  constructor({ durationMs, budget, keyframeTimesMs }: SamplerOptions) {
    if (!(durationMs > 0)) throw new Error('AdaptiveSampler requires a positive durationMs');
    this.durationMs = durationMs;
    this.budget = budget;
    this.keyframes = keyframeTimesMs ? [...keyframeTimesMs].sort((a, b) => a - b) : [];
    this.planSurvey();
  }

  private planSurvey(): void {
    // Never plan more samples than the video can meaningfully distinguish: a 2-second clip
    // does not have 16 usefully-different instants in it at a 250 ms floor.
    const maxUseful = Math.max(1, Math.floor(this.durationMs / this.budget.minSampleGapMs));
    const n = Math.max(1, Math.min(this.budget.surveyFrames, maxUseful, this.budget.maxFrames));
    this.surveyPlanned = n;

    const spacing = this.durationMs / n;
    for (let i = 0; i < n; i++) {
      // Cell CENTRES, not edges. The first and last frames of a video are the least
      // informative frames it has - fades from black, title cards, credits - and sampling at
      // t=0 reliably wastes one of our most expensive samples on a black frame.
      const raw = (i + 0.5) * spacing;
      const ts = this.snap(raw, spacing * 0.5);
      if (this.requested.has(ts)) continue;
      this.requested.add(ts);
      this.surveyQueue.push({
        tsMs: ts,
        phase: 'survey',
        onKeyframe: this.keyframes.length > 0 && ts !== Math.round(raw),
      });
    }
  }

  /**
   * Pull a timestamp onto the nearest container keyframe if one is close enough.
   *
   * Two reasons, both real: a keyframe decodes standalone (no dependent frames to walk), so
   * it is markedly cheaper to obtain; and encoders place keyframes at scene changes, so a
   * keyframe is on average a higher-information frame than an arbitrary instant. Free
   * accuracy and free speed, when the container gives us the index.
   */
  private snap(tsMs: number, toleranceMs: number): number {
    const rounded = Math.round(tsMs);
    if (this.keyframes.length === 0 || toleranceMs <= 0) return rounded;

    // Binary search for the insertion point, then check the two neighbours.
    let lo = 0;
    let hi = this.keyframes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyframes[mid] < tsMs) lo = mid + 1;
      else hi = mid;
    }
    let best = rounded;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const idx of [lo - 1, lo, lo + 1]) {
      const kf = this.keyframes[idx];
      if (kf === undefined) continue;
      const delta = Math.abs(kf - tsMs);
      // Skip a keyframe we have already sampled - snapping onto it would waste the sample.
      if (delta <= toleranceMs && delta < bestDelta && !this.requested.has(Math.round(kf))) {
        best = Math.round(kf);
        bestDelta = delta;
      }
    }
    return best;
  }

  /** Next timestamp worth sampling, or `null` when there is nothing left worth doing. */
  next(): SampleRequest | null {
    const surveyed = this.surveyQueue.shift();
    if (surveyed) return surveyed;

    if (!this.refineStarted) {
      this.refineStarted = true;
      this.seedRefinement();
    }

    for (;;) {
      const interval = this.heap.pop();
      if (!interval) return null;

      const span = interval.bMs - interval.aMs;
      if (span < this.budget.minSampleGapMs * 2) continue;

      const rawMid = (interval.aMs + interval.bMs) / 2;
      let mid = this.snap(rawMid, span / 4);
      if (this.requested.has(mid)) {
        mid = Math.round(rawMid);
        if (this.requested.has(mid)) continue;
      }

      this.requested.add(mid);
      this.inFlight.set(mid, interval);
      return { tsMs: mid, phase: 'refine', onKeyframe: mid !== Math.round(rawMid) };
    }
  }

  /**
   * Build the initial interval set from the survey.
   *
   * Includes the leading and trailing edges (0 -> first sample, last sample -> duration) so
   * content in the opening or closing seconds is still reachable, despite the survey
   * deliberately starting half a cell in.
   */
  private seedRefinement(): void {
    this.heap.clear();
    const obs = this.sortedObservations();
    if (obs.length === 0) return;

    const edges: Array<{ aMs: number; bMs: number; scoreA: number; scoreB: number }> = [];
    edges.push({ aMs: 0, bMs: obs[0].tsMs, scoreA: obs[0].score, scoreB: obs[0].score });
    for (let i = 0; i < obs.length - 1; i++) {
      edges.push({
        aMs: obs[i].tsMs,
        bMs: obs[i + 1].tsMs,
        scoreA: obs[i].score,
        scoreB: obs[i + 1].score,
      });
    }
    const last = obs[obs.length - 1];
    edges.push({ aMs: last.tsMs, bMs: this.durationMs, scoreA: last.score, scoreB: last.score });

    for (const e of edges) this.pushInterval(e.aMs, e.bMs, e.scoreA, e.scoreB);
  }

  private pushInterval(aMs: number, bMs: number, scoreA: number, scoreB: number): void {
    const span = bMs - aMs;
    if (span < this.budget.minSampleGapMs * 2) return;
    this.heap.push({
      aMs,
      bMs,
      scoreA,
      scoreB,
      priority: this.priorityOf(span, scoreA, scoreB),
    });
  }

  /**
   * Interval priority = suspicion x width.
   *
   * Suspicion uses the MAX of the two endpoint scores, not the mean: an interval bounded by
   * one clean frame and one flagged frame is precisely where the boundary of a scene lies,
   * and averaging would rank it below a pair of mildly-suspicious frames that tell us less.
   *
   * Width enters logarithmically, not linearly. Linear width lets one enormous empty gap
   * dominate the queue forever - halving it merely produces two still-enormous gaps - and
   * starves genuinely suspicious narrow intervals. Log keeps width as a meaningful tiebreak
   * without letting it overwhelm the signal.
   */
  private priorityOf(spanMs: number, scoreA: number, scoreB: number): number {
    const suspicion = BASE_PRIORITY + Math.max(scoreA, scoreB);
    const width = Math.log2(1 + spanMs / this.budget.minSampleGapMs);
    return suspicion * width;
  }

  /** Record a scored sample. Queues the two child intervals if this was a refinement midpoint. */
  observe(tsMs: number, score: number): void {
    this.observations.push({ tsMs, score });
    const parent = this.inFlight.get(tsMs);
    if (parent) {
      this.inFlight.delete(tsMs);
      this.pushInterval(parent.aMs, tsMs, parent.scoreA, score);
      this.pushInterval(tsMs, parent.bMs, score, parent.scoreB);
    }
  }

  /**
   * Record a sample the source could not produce (a failed seek, a decode gap).
   *
   * The interval is still split so refinement can proceed - a single unreadable timestamp
   * must not permanently block progress on the region around it - but nothing is added to the
   * observation set, so a failed frame never contributes to coverage or to the verdict.
   */
  fail(tsMs: number): void {
    const parent = this.inFlight.get(tsMs);
    if (!parent) return;
    this.inFlight.delete(tsMs);
    this.pushInterval(parent.aMs, tsMs, parent.scoreA, parent.scoreA);
    this.pushInterval(tsMs, parent.bMs, parent.scoreB, parent.scoreB);
  }

  private sortedObservations(): Array<{ tsMs: number; score: number }> {
    return [...this.observations].sort((a, b) => a.tsMs - b.tsMs);
  }

  get observedCount(): number {
    return this.observations.length;
  }

  get surveyRemaining(): number {
    return this.surveyQueue.length;
  }

  get surveyTotal(): number {
    return this.surveyPlanned;
  }

  /**
   * Rough completion estimate for the progress bar, in [0, 1].
   *
   * Refinement has no natural end - it is bounded by budget, not by a work list - so progress
   * during Phase B is reported against the frame budget. Honest, and it never goes backwards.
   */
  progress(): number {
    if (this.surveyQueue.length > 0) {
      const done = this.surveyPlanned - this.surveyQueue.length;
      return (done / Math.max(1, this.surveyPlanned)) * 0.5;
    }
    const refineBudget = Math.max(1, this.budget.maxFrames - this.surveyPlanned);
    const refined = Math.max(0, this.observations.length - this.surveyPlanned);
    return 0.5 + Math.min(1, refined / refineBudget) * 0.5;
  }
}
