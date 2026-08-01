import { describe, expect, it } from 'vitest';
import { BASE_BUDGET, type ScanBudget } from './config';
import { AdaptiveSampler } from './sampler';

const budget = (overrides: Partial<ScanBudget> = {}): ScanBudget => ({
  ...BASE_BUDGET,
  ...overrides,
});

/** Drain the sampler, feeding back a score chosen by `scoreFor`, up to `limit` samples. */
function run(
  sampler: AdaptiveSampler,
  scoreFor: (tsMs: number) => number,
  limit: number
): number[] {
  const seen: number[] = [];
  for (let i = 0; i < limit; i++) {
    const req = sampler.next();
    if (!req) break;
    seen.push(req.tsMs);
    sampler.observe(req.tsMs, scoreFor(req.tsMs));
  }
  return seen;
}

describe('survey phase', () => {
  it('rejects a video with no known duration', () => {
    expect(() => new AdaptiveSampler({ durationMs: 0, budget: budget() })).toThrow();
  });

  it('plans exactly surveyFrames samples for a long video', () => {
    const s = new AdaptiveSampler({ durationMs: 600_000, budget: budget({ surveyFrames: 16 }) });
    expect(s.surveyTotal).toBe(16);
    expect(s.surveyRemaining).toBe(16);
  });

  it('samples cell centres, so it never wastes a sample on the black frame at t=0', () => {
    const s = new AdaptiveSampler({ durationMs: 16_000, budget: budget({ surveyFrames: 16 }) });
    const first = s.next()!;
    expect(first.tsMs).toBe(500);
    expect(first.phase).toBe('survey');
  });

  it('spreads survey samples evenly across the whole timeline', () => {
    const s = new AdaptiveSampler({ durationMs: 32_000, budget: budget({ surveyFrames: 8 }) });
    const ts = run(s, () => 0, 8);
    expect(ts).toEqual([2_000, 6_000, 10_000, 14_000, 18_000, 22_000, 26_000, 30_000]);
  });

  it('does not oversample a video too short to have that many distinct instants', () => {
    // 1.2 s at a 250 ms floor supports 4 usefully-different samples, not 16.
    const s = new AdaptiveSampler({
      durationMs: 1_200,
      budget: budget({ surveyFrames: 16, minSampleGapMs: 250 }),
    });
    expect(s.surveyTotal).toBe(4);
  });

  it('always plans at least one sample, even for a very short clip', () => {
    const s = new AdaptiveSampler({ durationMs: 80, budget: budget() });
    expect(s.surveyTotal).toBe(1);
    expect(s.next()).not.toBeNull();
  });

  it('has a survey cost independent of duration - the responsiveness property', () => {
    const short = new AdaptiveSampler({ durationMs: 30_000, budget: budget() });
    const long = new AdaptiveSampler({ durationMs: 7_200_000, budget: budget() });
    expect(short.surveyTotal).toBe(long.surveyTotal);
  });
});

describe('keyframe snapping', () => {
  it('pulls a sample onto a nearby keyframe', () => {
    const s = new AdaptiveSampler({
      durationMs: 16_000,
      budget: budget({ surveyFrames: 16 }),
      keyframeTimesMs: [480, 1_490],
    });
    const first = s.next()!;
    expect(first.tsMs).toBe(480);
    expect(first.onKeyframe).toBe(true);
  });

  it('ignores keyframes outside the tolerance window', () => {
    const s = new AdaptiveSampler({
      durationMs: 16_000,
      budget: budget({ surveyFrames: 16 }),
      // Tolerance is half a cell (500 ms) around the 500 ms target; 3 s is far outside it.
      keyframeTimesMs: [3_000],
    });
    expect(s.next()!.tsMs).toBe(500);
  });

  it('never snaps two survey samples onto the same keyframe', () => {
    const s = new AdaptiveSampler({
      durationMs: 8_000,
      budget: budget({ surveyFrames: 8 }),
      keyframeTimesMs: [1_000],
    });
    const ts = run(s, () => 0, 8);
    expect(new Set(ts).size).toBe(ts.length);
  });
});

describe('refinement phase', () => {
  it('moves to refinement once the survey is exhausted', () => {
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0, 4);
    const next = s.next();
    expect(next).not.toBeNull();
    expect(next!.phase).toBe('refine');
  });

  it('concentrates refinement around the suspicious region', () => {
    // One hot spot at 20 s in a 60 s video; refinement should crowd around it.
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 6 }) });
    const hot = (ts: number) => (Math.abs(ts - 20_000) < 6_000 ? 0.9 : 0.02);
    run(s, hot, 6);
    const refined = run(s, hot, 12);

    const nearHotspot = refined.filter((ts) => Math.abs(ts - 20_000) <= 10_000).length;
    expect(nearHotspot / refined.length).toBeGreaterThan(0.5);
  });

  it('still refines the widest gaps when nothing at all looks suspicious', () => {
    // Without a baseline priority every interval would tie at zero and refinement would
    // have no basis to choose; it must degrade to "bisect the biggest hole".
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0, 4);
    const refined = run(s, () => 0, 6);
    expect(refined.length).toBe(6);
    expect(new Set(refined).size).toBe(6);
  });

  it('never samples the same timestamp twice', () => {
    const s = new AdaptiveSampler({ durationMs: 120_000, budget: budget({ surveyFrames: 8 }) });
    const all = run(s, (ts) => (ts % 7_000 < 1_000 ? 0.8 : 0.1), 200);
    expect(new Set(all).size).toBe(all.length);
  });

  it('reaches content in the opening and closing seconds', () => {
    // The survey deliberately starts half a cell in, so the leading and trailing edges have
    // to be reachable during refinement or those regions would be permanently invisible.
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0.5, 4);
    const refined = run(s, () => 0.5, 20);
    expect(Math.min(...refined)).toBeLessThan(7_500);
    expect(Math.max(...refined)).toBeGreaterThan(52_500);
  });

  it('terminates instead of subdividing forever', () => {
    const s = new AdaptiveSampler({
      durationMs: 6_000,
      budget: budget({ surveyFrames: 4, minSampleGapMs: 500 }),
    });
    const all = run(s, () => 0.9, 10_000);
    expect(s.next()).toBeNull();
    // Bounded by minSampleGapMs: 6 s at a 500 ms floor cannot yield hundreds of samples.
    expect(all.length).toBeLessThan(40);
  });

  it('is deterministic: identical inputs produce an identical sample order', () => {
    const make = () =>
      new AdaptiveSampler({
        durationMs: 90_000,
        budget: budget({ surveyFrames: 6 }),
        keyframeTimesMs: [1_000, 12_345, 40_000, 71_000],
      });
    const score = (ts: number) => (ts / 90_000) * 0.8;
    expect(run(make(), score, 40)).toEqual(run(make(), score, 40));
  });
});

describe('failed samples', () => {
  it('keeps making progress when a refinement frame cannot be decoded', () => {
    // One unreadable timestamp must not permanently wedge the region around it.
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0.1, 4);

    const failed = s.next()!;
    s.fail(failed.tsMs);

    const after = s.next();
    expect(after).not.toBeNull();
    expect(after!.tsMs).not.toBe(failed.tsMs);
  });

  it('does not count a failed frame as an observation', () => {
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0.1, 4);
    const before = s.observedCount;
    s.fail(s.next()!.tsMs);
    expect(s.observedCount).toBe(before);
  });
});

describe('progress reporting', () => {
  it('advances through the survey and never goes backwards', () => {
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    let last = s.progress();
    expect(last).toBe(0);
    for (let i = 0; i < 20; i++) {
      const req = s.next();
      if (!req) break;
      s.observe(req.tsMs, 0.1);
      const now = s.progress();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBeGreaterThan(0.5);
    expect(last).toBeLessThanOrEqual(1);
  });

  it('reports the survey as exactly half the work', () => {
    const s = new AdaptiveSampler({ durationMs: 60_000, budget: budget({ surveyFrames: 4 }) });
    run(s, () => 0.1, 4);
    expect(s.progress()).toBe(0.5);
  });
});
