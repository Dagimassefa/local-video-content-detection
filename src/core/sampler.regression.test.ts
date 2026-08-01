import { describe, expect, it } from 'vitest';
import { budgetForTier } from './config';
import { AdaptiveSampler } from './sampler';

/**
 * Regressions found by running the real pipeline against real files (`npm run bench`), not by
 * reasoning about the code. Each one is reproduced here at the unit level so it stays fixed.
 */
describe('regression: refinement must actually run after the survey', () => {
  /**
   * Observed in the benchmark: `scenes-30s.mp4` reported `stopReason: 'complete'` after exactly
   * 16 frames - the survey count - and never entered Phase B at all. On a 30-second video with
   * ~1.9 s between survey samples there is obviously refinable space left, so "complete" was a
   * lie and the entire adaptive half of the algorithm was silently inert.
   */
  it('enters refinement on a 30s video with a keyframe every 3s', () => {
    const budget = { ...budgetForTier('high') };
    const keyframeTimesMs = [0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000];
    const sampler = new AdaptiveSampler({ durationMs: 29_900, budget, keyframeTimesMs });

    const phases: string[] = [];
    for (let i = 0; i < 200; i++) {
      const request = sampler.next();
      if (!request) break;
      phases.push(request.phase);
      sampler.observe(request.tsMs, 0.1);
    }

    expect(phases.filter((p) => p === 'survey').length).toBe(sampler.surveyTotal);
    expect(phases.filter((p) => p === 'refine').length).toBeGreaterThan(0);
  });

  /**
   * The root cause. `snap()` refuses to reuse an already-requested timestamp, but on the
   * REFINEMENT path the fallback was `Math.round(rawMid)` - and when the interval midpoint had
   * itself already been snapped onto a keyframe during the survey, both the snapped candidate
   * and the raw midpoint could collide with existing samples, so the interval was silently
   * dropped via `continue`. With few keyframes and a coarse survey, enough intervals were
   * dropped in a row that the heap drained and `next()` returned null.
   */
  it('does not discard an interval just because its midpoint was already sampled', () => {
    const budget = { ...budgetForTier('medium'), surveyFrames: 4, minSampleGapMs: 250 };
    // Keyframes deliberately placed exactly on the midpoints the refiner will try first.
    const sampler = new AdaptiveSampler({
      durationMs: 20_000,
      budget,
      keyframeTimesMs: [2_500, 7_500, 12_500, 17_500],
    });

    let count = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const request = sampler.next();
      if (!request) break;
      expect(seen.has(request.tsMs)).toBe(false);
      seen.add(request.tsMs);
      sampler.observe(request.tsMs, 0.2);
      count++;
    }
    // 20 s at a 250 ms floor supports far more than the 4 survey samples.
    expect(count).toBeGreaterThan(12);
  });

  it('keeps refining a long video up to the frame budget', () => {
    const budget = { ...budgetForTier('high') };
    const sampler = new AdaptiveSampler({ durationMs: 179_200, budget });
    let count = 0;
    while (count < budget.maxFrames) {
      const request = sampler.next();
      if (!request) break;
      sampler.observe(request.tsMs, 0.05);
      count++;
    }
    expect(count).toBe(budget.maxFrames);
  });
});
