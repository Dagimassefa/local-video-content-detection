import { describe, expect, it } from 'vitest';
import { BASE_BUDGET } from './config';
import { governBudget, resolutionFloorMs } from './governor';

const base = BASE_BUDGET;

describe('governBudget', () => {
  it('does nothing before there are enough measurements', () => {
    const out = governBudget({ original: base, observedP50Ms: 500, sampleCount: 3 });
    expect(out.throttled).toBe(false);
    expect(out.budget).toBe(base);
  });

  it('does nothing when latency is at or near target', () => {
    expect(
      governBudget({ original: base, observedP50Ms: base.targetInferenceMs, sampleCount: 40 })
        .throttled
    ).toBe(false);
    // Slightly over is still within tolerance - reacting to noise would make the scan jittery.
    expect(
      governBudget({ original: base, observedP50Ms: base.targetInferenceMs * 1.4, sampleCount: 40 })
        .throttled
    ).toBe(false);
  });

  it('shrinks the frame budget on a device measurably over target', () => {
    const out = governBudget({ original: base, observedP50Ms: 135, sampleCount: 40 });
    expect(out.throttled).toBe(true);
    expect(out.budget.maxFrames).toBeLessThan(base.maxFrames);
    expect(out.budget.minSampleGapMs).toBeGreaterThan(base.minSampleGapMs);
  });

  it('IS IDEMPOTENT - the bug that broke adaptive refinement', () => {
    // The original implementation mutated the live budget once per classified frame, so a device
    // 1.66x over target had its budget multiplied by 1.66 AGAIN on every frame. After ten frames
    // minSampleGapMs had compounded from 250 ms to ~40 s, no interval was wide enough to bisect,
    // and the scan reported "complete" after only the survey.
    const once = governBudget({ original: base, observedP50Ms: 120, sampleCount: 40 });
    for (let i = 0; i < 50; i++) {
      const again = governBudget({ original: base, observedP50Ms: 120, sampleCount: 40 + i });
      expect(again.budget.maxFrames).toBe(once.budget.maxFrames);
      expect(again.budget.minSampleGapMs).toBe(once.budget.minSampleGapMs);
    }
  });

  it('never coarsens refinement enough to disable it', () => {
    // Even on an absurdly slow device the sampling floor must stay small relative to a normal
    // video, or refinement silently stops happening at all.
    const out = governBudget({ original: base, observedP50Ms: 100_000, sampleCount: 200 });
    expect(out.budget.minSampleGapMs).toBeLessThanOrEqual(base.minSampleGapMs * 2);
    expect(out.budget.minSampleGapMs).toBeLessThan(1_000);
  });

  it('never reduces the frame budget below a usable floor', () => {
    const out = governBudget({ original: base, observedP50Ms: 100_000, sampleCount: 200 });
    expect(out.budget.maxFrames).toBeGreaterThanOrEqual(16);
  });

  it('degrades monotonically with measured latency', () => {
    const frames = [60, 120, 240, 480].map(
      (ms) => governBudget({ original: base, observedP50Ms: ms, sampleCount: 40 }).budget.maxFrames
    );
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeLessThanOrEqual(frames[i - 1]);
    }
  });

  it('leaves every other budget field untouched', () => {
    const out = governBudget({ original: base, observedP50Ms: 200, sampleCount: 40 });
    expect(out.budget.surveyFrames).toBe(base.surveyFrames);
    expect(out.budget.maxWallClockMs).toBe(base.maxWallClockMs);
    expect(out.budget.dedupeHammingThreshold).toBe(base.dedupeHammingThreshold);
    expect(out.budget.targetInferenceMs).toBe(base.targetInferenceMs);
  });

  it('recovers if the device speeds back up', () => {
    // Only ever computed from the original budget, so a device that cools down is not stuck with
    // a permanently reduced scan.
    const slow = governBudget({ original: base, observedP50Ms: 200, sampleCount: 40 });
    const recovered = governBudget({ original: base, observedP50Ms: 40, sampleCount: 80 });
    expect(slow.throttled).toBe(true);
    expect(recovered.throttled).toBe(false);
    expect(recovered.budget.maxFrames).toBe(base.maxFrames);
  });
});

describe('resolutionFloorMs', () => {
  const floor = (duplicateCount: number, currentFloorMs = 250, durationMs = 60_000) =>
    resolutionFloorMs({ currentFloorMs, duplicateCount, durationMs });

  it('tolerates a couple of duplicates without reacting', () => {
    // A duplicate or two is normal - seeks land on frame boundaries. Backing off immediately
    // would coarsen sampling on files that are perfectly fine.
    expect(floor(0)).toBe(250);
    expect(floor(2)).toBe(250);
  });

  it('widens once duplicates become a pattern', () => {
    expect(floor(3)).toBeGreaterThan(250);
    expect(floor(6)).toBeGreaterThan(floor(4));
  });

  it('is monotone in the duplicate count', () => {
    let previous = 0;
    for (const n of [0, 3, 4, 5, 8, 12]) {
      const value = floor(n);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('never coarsens past an eighth of the video, so refinement stays possible', () => {
    // Runaway backoff would disable refinement entirely - the same class of bug as the
    // compounding latency governor.
    expect(floor(200, 250, 60_000)).toBeLessThanOrEqual(60_000 / 8);
    expect(floor(200, 250, 8_000)).toBeLessThanOrEqual(8_000 / 8);
  });

  it('never returns something narrower than the floor it was given', () => {
    for (const n of [0, 1, 5, 50]) {
      expect(floor(n, 400, 5_000)).toBeGreaterThanOrEqual(400);
    }
  });

  it('is a pure function of the baseline, not of its own previous output', () => {
    // Feeding the result back in as the baseline is what compounds; called correctly with a
    // fixed baseline it is stable for a given duplicate count.
    expect(floor(5)).toBe(floor(5));
  });
});

