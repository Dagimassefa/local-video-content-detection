import { aggregate, shouldEarlyExit } from './aggregate';
import { CONTENT_CATEGORIES, type CategoryScores, type ContentCategory } from './categories';
import { combineCategoryScores, mergeDetectorResults, type Detector } from './detector/Detector';
import { POLICIES, type ScanBudget, type ScanConfig } from './config';
import { PerceptualCache } from './dhash';
import { governBudget, resolutionFloorMs } from './governor';
import type { FrameSource } from './frames/FrameSource';
import { ScanError } from './frames/FrameSource';
import { MetricsRegistry, TIMER } from './metrics';
import { AdaptiveSampler } from './sampler';

import type {
  FrameScore,
  PerfSnapshot,
  ScanEvent,
  ScanResult,
  ScanStats,
  StopReason,
} from './types';

/**
 * The orchestrator: drives the sampler, the frame source and the classifier, and streams
 * progressively-refined results out as it goes.
 *
 * The design goal is that this loop is *interruptible at every point*. It never commits to
 * "finish the scan then report"; it always has a current best answer, publishes it, and keeps
 * improving it until something tells it to stop - a budget, a decisive verdict, a hidden tab,
 * or the user. That property is what makes the prototype feel responsive on a two-hour video,
 * and it is a property of the control flow here rather than of any individual component.
 */

export interface PipelineDeps {
  source: FrameSource;
  /** One or more detectors. Each contributes per-category scores for the same frame. */
  detectors: Detector[];
  config: ScanConfig;
  emit(event: ScanEvent): void;
  signal: AbortSignal;
  /**
   * Resolves while the scan should stay paused (hidden tab). Injected rather than reading
   * `document` directly so `core/` stays DOM-free and portable.
   */
  waitWhilePaused?: () => Promise<void>;
  /** Produce a small thumbnail for a flagged frame. Optional: purely a UI affordance. */
  makeThumbnail?: (bitmap: ImageBitmap) => Promise<string | undefined>;
  clock?: () => number;
}

export async function runScan(deps: PipelineDeps): Promise<ScanResult> {
  const { source, detectors, config, emit, signal } = deps;
  const clock = deps.clock ?? (() => performance.now());
  const policy = POLICIES[config.policyId];
  const metrics = new MetricsRegistry(clock);

  emit({ type: 'phase', phase: 'loading-model' });
  if (detectors.length === 0) throw new Error('runScan requires at least one detector');
  // Every detector is initialised before scanning starts, so a model-load failure surfaces up front
  // rather than partway through a scan. The first detector's backend info is reported, since they all
  // share one runtime.
  const backendInfos = [];
  for (const detector of detectors) backendInfos.push(await detector.init(config.backend, signal));
  const backendInfo = backendInfos[0];
  emit({ type: 'model-ready', info: backendInfo });

  /**
   * The scan clock starts AFTER the model is ready, not before.
   *
   * `maxWallClockMs` is a budget for *scanning*, and model load is a one-time cost that is already
   * reported separately. Counting it against the scan budget means a slow cold start silently eats
   * the frames: benchmarking the WebGL backend on Intel Iris Xe measured a 16-second model load
   * (shader compilation across the whole graph), which consumed the entire 20-second budget and
   * left the scan with 13 frames and a `time-budget` stop. The verdict was starved by a cost that
   * has nothing to do with how long the video is.
   */
  const startedAt = clock();

  emit({ type: 'phase', phase: 'probing' });
  const meta = await source.probe(signal);
  emit({ type: 'meta', meta });

  // `configuredBudget` is never mutated - it is the reference the governor recomputes from, which
  // is what keeps the governor idempotent (see `core/governor.ts`). `budget` is the live object
  // the sampler reads, updated in place so a mid-scan adjustment reaches it.
  const configuredBudget: ScanBudget = { ...config.budget };

  // Never ask for finer temporal detail than the source can deliver. See
  // `VideoMeta.temporalResolutionMs` - without this floor, refinement bisects down to 250 ms on a
  // long-GOP file, gets the same keyframe back repeatedly, and spends frame budget on requests
  // that cannot return anything new.
  if (meta.temporalResolutionMs && meta.temporalResolutionMs > configuredBudget.minSampleGapMs) {
    configuredBudget.minSampleGapMs = Math.round(meta.temporalResolutionMs);
    emit({
      type: 'phase',
      phase: 'probing',
      detail: `source resolves to ${Math.round(meta.temporalResolutionMs)} ms; refinement floor raised to match`,
    });
  }

  const budget: ScanBudget = { ...configuredBudget };
  /** Fixed baseline for the duplicate backoff, so it can never compound into itself. */
  const baseSampleGapMs = configuredBudget.minSampleGapMs;

  const sampler = new AdaptiveSampler({
    durationMs: meta.durationMs,
    budget,
    keyframeTimesMs: meta.keyframeTimesMs,
  });

  /**
   * Coverage is derived from the detectors that ACTUALLY RAN, not from static metadata.
   *
   * Reading it off `CATEGORY_META` meant enabling the violence detector produced violence scores on
   * every frame while the payload still reported violence as unscreened - the taxonomy contradicting
   * the data next to it. The whole value of declaring coverage is that it describes this scan.
   */
  const actuallyScreened: ContentCategory[] = [
    ...new Set(detectors.flatMap((d) => d.categories)),
  ];
  const actuallyUnscreened: ContentCategory[] = CONTENT_CATEGORIES.filter(
    (c) => !actuallyScreened.includes(c)
  );

  const frames: FrameScore[] = [];
  // Keyed by hash -> the score we already paid for. Bounded and recency-ordered, because
  // visual redundancy in video is overwhelmingly local.
  const seen = new PerceptualCache<{ score: number; classes: FrameScore['classes']; categories: CategoryScores }>(
    budget.dedupeHammingThreshold,
    24
  );

  /**
   * Actual delivered timestamps already recorded.
   *
   * The sampler guarantees it never REQUESTS the same instant twice, but the source returns the
   * frame it actually produced - and keyframe snapping in the WebCodecs path, or seek quantisation
   * in the `<video>` path, means two different requests can legitimately resolve to the same
   * frame. Recording it twice would let one frame masquerade as corroborating evidence in the
   * top-K mean, which is exactly the kind of double-counting the persistence gate exists to
   * prevent. One frame, one vote.
   */
  const recordedTimestamps = new Set<number>();

  let stopReason: StopReason | null = null;
  let timeToFirstVerdictMs: number | null = null;
  let inferred = 0;
  let deduped = 0;
  let failed = 0;
  let duplicates = 0;
  let lastEmit = 0;

  const snapshot = (finalized: boolean): { result: ScanResult; perf: PerfSnapshot } => {
    const summary = aggregate({ frames, policy, durationMs: meta.durationMs });
    const stats: ScanStats = {
      durationMs: meta.durationMs,
      sampledFrames: frames.length,
      inferredFrames: inferred,
      dedupedFrames: deduped,
      failedFrames: failed,
      duplicateFrames: duplicates,
      coverage: summary.coverage,
      elapsedMs: Math.round(clock() - startedAt),
      timeToFirstVerdictMs,
      source: source.kind,
      backend: backendInfo.backend,
      stopReason,
      screenedCategories: actuallyScreened,
      unscreenedCategories: actuallyUnscreened,
    };
    return {
      result: {
        verdict: summary.verdict,
        frames: [...frames].sort((a, b) => a.tsMs - b.tsMs),
        segments: summary.segments,
        stats,
        phase: finalized ? 'done' : sampler.surveyRemaining > 0 ? 'survey' : 'refine',
        finalized,
      },
      perf: metrics.snapshot({ tensors: detectors[0]?.memory?.() }),
    };
  };

  const publish = (force = false) => {
    const now = clock();
    // Coalesced to ~10 Hz. The worker can produce results far faster than a human can read
    // them, and flooding the main thread with postMessage traffic would make the UI janky -
    // which would be a self-inflicted version of the exact problem the worker exists to solve.
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    const { result, perf } = snapshot(false);
    emit({ type: 'progress', result, perf });
  };

  emit({ type: 'phase', phase: 'survey' });

  try {
    for (;;) {
      if (signal.aborted) {
        stopReason = 'cancelled';
        break;
      }

      // Pause on a hidden tab BEFORE spending anything. Background scanning is pure battery
      // drain on a screen nobody is looking at, and on mobile the OS will throttle us into
      // uselessness anyway.
      if (config.pauseWhenHidden && deps.waitWhilePaused) {
        await deps.waitWhilePaused();
        if (signal.aborted) {
          stopReason = 'cancelled';
          break;
        }
      }

      if (frames.length >= budget.maxFrames) {
        stopReason = 'frame-budget';
        break;
      }
      if (clock() - startedAt > budget.maxWallClockMs) {
        stopReason = 'time-budget';
        break;
      }

      const request = sampler.next();

      // Mark the end of the survey the moment its queue drains - NOT when a refinement frame is
      // requested. Those are not the same instant, and conflating them meant every scan that
      // early-exited or completed during the survey reported a null time-to-first-verdict, losing
      // the single number that best demonstrates responsiveness. Fixed after `npm run bench`
      // showed nulls for exactly those cases.
      if (timeToFirstVerdictMs === null && sampler.surveyRemaining === 0 && frames.length > 0) {
        timeToFirstVerdictMs = Math.round(clock() - startedAt);
        if (request?.phase === 'refine') emit({ type: 'phase', phase: 'refine' });
        publish(true);
      }

      if (!request) {
        stopReason = 'complete';
        break;
      }

      const stopFrame = metrics.start(TIMER.frameTotal);
      const stopDecode = metrics.start(TIMER.decode);
      const sampled = await source.frameAt(request.tsMs, signal);
      stopDecode();

      if (!sampled) {
        failed++;
        sampler.fail(request.tsMs);
        stopFrame();
        continue;
      }

      try {
        // --- Deduplication -------------------------------------------------------------
        // The cheapest possible optimisation: don't run the model at all. A hash of
        // '0000000000000000' means hashing failed, and must never match - degrading to
        // "classify everything" is slower but correct, whereas a false match would attach a
        // score to a frame we never looked at.
        const hashUsable = sampled.hash !== '0000000000000000';
        const hit = config.dedupe && hashUsable ? seen.find(sampled.hash) : undefined;

        let score: number;
        let classes: FrameScore['classes'];
        let categories: CategoryScores;
        let inherit = false;

        if (hit) {
          score = hit.score;
          classes = hit.classes;
          categories = hit.categories;
          inherit = true;
          deduped++;
          metrics.increment('deduped');
        } else {
          const stopInfer = metrics.start(TIMER.inference);
          // Every detector sees the same bitmap. Sequential rather than parallel on purpose: they
          // contend for one GPU/WASM runtime, so running them concurrently adds scheduling overhead
          // without adding throughput. With one detector registered this is exactly the previous
          // single call.
          const results = [];
          for (const detector of detectors) {
            results.push(await detector.score(sampled.bitmap, policy));
          }
          stopInfer();
          const merged = mergeDetectorResults(results);
          categories = merged.categories;
          classes = merged.detail ?? { Drawing: 0, Hentai: 0, Neutral: 1, Porn: 0, Sexy: 0 };
          inferred++;
          score = combineCategoryScores(categories, policy);
          if (hashUsable) seen.add(sampled.hash, { score, classes, categories });

          const inferStats = metrics.snapshot().timers[TIMER.inference];
          const governed = governBudget({
            original: configuredBudget,
            observedP50Ms: inferStats?.p50 ?? 0,
            sampleCount: inferStats?.count ?? 0,
          });
          // Copied onto the live object rather than replaced, because the sampler holds a
          // reference to it.
          Object.assign(budget, governed.budget);
          if (governed.throttled) metrics.increment('governor.throttled');
        }

        let thumbnail: string | undefined;
        // Thumbnails only for flagged frames: bounded cost, and it is the flagged ones the UI
        // needs to show (blurred) on the timeline.
        if (score >= policy.frameThreshold && deps.makeThumbnail) {
          thumbnail = await deps.makeThumbnail(sampled.bitmap);
        }

        if (recordedTimestamps.has(sampled.tsMs)) {
          duplicates++;
          metrics.increment('duplicate-timestamp');
          // Measured evidence that we are asking for finer detail than this source can resolve.
          // Computed from the IMMUTABLE baseline rather than from the current value - compounding
          // a backoff into its own input is precisely the bug that broke the latency governor.
          configuredBudget.minSampleGapMs = resolutionFloorMs({
            currentFloorMs: baseSampleGapMs,
            duplicateCount: duplicates,
            durationMs: meta.durationMs,
          });
          budget.minSampleGapMs = configuredBudget.minSampleGapMs;
        } else {
          recordedTimestamps.add(sampled.tsMs);
          frames.push({
            tsMs: sampled.tsMs,
            score,
            classes,
            categories,
            inherited: inherit,
            hash: sampled.hash,
            thumbnail,
          });
        }
        // Observe at the REQUESTED timestamp: the sampler's interval bookkeeping is keyed on
        // what it asked for, while the frame itself records where we actually landed.
        sampler.observe(request.tsMs, score);
        stopFrame();

        publish();

        if (config.earlyExit) {
          const summary = aggregate({ frames, policy, durationMs: meta.durationMs });
          if (shouldEarlyExit(summary, policy)) {
            stopReason = 'early-exit';
            break;
          }
        }
      } finally {
        // One bitmap per sample, closed unconditionally. ImageBitmaps hold GPU-side memory
        // that the garbage collector will not reclaim promptly; leaking one per frame over a
        // 120-frame scan is a visible memory climb.
        sampled.bitmap.close();
      }
    }
  } catch (err) {
    if (isAbort(err) || signal.aborted) {
      stopReason = 'cancelled';
    } else {
      stopReason = 'error';
      const scanError =
        err instanceof ScanError
          ? err
          : new ScanError(err instanceof Error ? err.message : String(err), 'unknown');
      emit({ type: 'error', message: scanError.message, kind: scanError.kind });
      throw scanError;
    }
  }

  // A scan that early-exited or ran out of budget during Phase A never reached the "survey
  // drained" checkpoint, but it still produced a verdict - and that verdict was its first. Report
  // the elapsed time rather than a null, which would read as "we never got an answer".
  if (timeToFirstVerdictMs === null && frames.length > 0) {
    timeToFirstVerdictMs = Math.round(clock() - startedAt);
  }

  if (frames.length === 0 && stopReason !== 'cancelled') {
    throw new ScanError(
      'No frames could be decoded from this video, so there is nothing to classify.',
      'no-frames'
    );
  }

  const { result, perf } = snapshot(true);
  result.phase = stopReason === 'cancelled' ? 'cancelled' : 'done';
  emit({ type: 'phase', phase: result.phase });
  emit({ type: 'done', result, perf });
  return result;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
