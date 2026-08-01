import { describe, expect, it } from 'vitest';
import {
  aggregate,
  buildSegments,
  negativeConfidence,
  positiveConfidence,
  shouldEarlyExit,
  temporalCoverage,
} from './aggregate';
import { POLICIES } from './config';
import type { ClassScores, FrameScore } from './types';

const balanced = POLICIES.balanced;
const strict = POLICIES.strict;

const classes = (porn: number, neutral = 1 - porn): ClassScores => ({
  Drawing: 0,
  Hentai: 0,
  Neutral: neutral,
  Porn: porn,
  Sexy: 0,
});

const frame = (tsMs: number, score: number): FrameScore => ({
  tsMs,
  score,
  classes: classes(score),
  inherited: false,
  hash: '0000000000000000',
});

describe('temporalCoverage', () => {
  it('is zero with no samples', () => {
    expect(temporalCoverage([], 10_000)).toBe(0);
  });

  it('fully covers a short clip that was densely sampled', () => {
    // 30 s clip, samples every ~2 s, each vouching +/-2 s -> saturated.
    const ts = Array.from({ length: 16 }, (_, i) => (i + 0.5) * (30_000 / 16));
    expect(temporalCoverage(ts, 30_000)).toBe(1);
  });

  it('reports near-zero coverage for a handful of samples across a long video', () => {
    // THE case this metric exists for: 16 samples cannot vouch for two hours, and a negative
    // verdict must not be allowed to pretend otherwise.
    const ts = Array.from({ length: 16 }, (_, i) => (i + 0.5) * (7_200_000 / 16));
    const coverage = temporalCoverage(ts, 7_200_000);
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(0.02);
  });

  it('never lets neighbouring samples double-count the same ground', () => {
    // Two samples 200 ms apart can each only claim 100 ms inward, not the full 2 s radius.
    const coverage = temporalCoverage([5_000, 5_200], 60_000);
    const expected = (2_000 + 100 + 100 + 2_000) / 60_000;
    expect(coverage).toBeCloseTo(expected, 6);
  });

  it('increases monotonically as samples are added', () => {
    const a = temporalCoverage([10_000], 120_000);
    const b = temporalCoverage([10_000, 60_000], 120_000);
    const c = temporalCoverage([10_000, 60_000, 110_000], 120_000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe('verdict gating', () => {
  it('returns a negative verdict when there are no frames at all', () => {
    const out = aggregate({ frames: [], policy: balanced, durationMs: 10_000 });
    expect(out.verdict.contains_inappropriate_content).toBe(false);
  });

  it('does not flag a video on one mid-confidence frame', () => {
    // The whole point of persistence gating: 0.7 clears the frame threshold but is nowhere
    // near the single-frame threshold, and nothing corroborates it.
    const out = aggregate({ frames: [frame(1_000, 0.7)], policy: balanced, durationMs: 30_000 });
    expect(out.verdict.contains_inappropriate_content).toBe(false);
    expect(out.flaggedCount).toBe(1);
  });

  it('flags on two independent frames over the threshold', () => {
    const out = aggregate({
      frames: [frame(1_000, 0.7), frame(9_000, 0.72)],
      policy: balanced,
      durationMs: 30_000,
    });
    expect(out.verdict.contains_inappropriate_content).toBe(true);
    expect(out.independentFlaggedCount).toBe(2);
  });

  it('does NOT flag on two frames too close together to be independent evidence', () => {
    const out = aggregate({
      frames: [frame(1_000, 0.7), frame(1_100, 0.72)],
      policy: balanced,
      durationMs: 30_000,
    });
    expect(out.flaggedCount).toBe(2);
    expect(out.independentFlaggedCount).toBe(1);
    expect(out.verdict.contains_inappropriate_content).toBe(false);
  });

  it('flags on a single near-certain frame without corroboration', () => {
    const out = aggregate({ frames: [frame(4_000, 0.97)], policy: balanced, durationMs: 30_000 });
    expect(out.verdict.contains_inappropriate_content).toBe(true);
  });

  it('applies the strict profile more readily than the balanced one', () => {
    const frames = [frame(1_000, 0.45)];
    expect(
      aggregate({ frames, policy: strict, durationMs: 30_000 }).verdict
        .contains_inappropriate_content
    ).toBe(true);
    expect(
      aggregate({ frames, policy: balanced, durationMs: 30_000 }).verdict
        .contains_inappropriate_content
    ).toBe(false);
  });
});

describe('confidence', () => {
  it('always lands in [0.5, 0.99] and never claims certainty', () => {
    for (const score of [0, 0.1, 0.3, 0.55, 0.8, 0.99, 1]) {
      for (const n of [0, 1, 2, 5, 50]) {
        expect(positiveConfidence(score, n, balanced)).toBeGreaterThanOrEqual(0.5);
        expect(positiveConfidence(score, n, balanced)).toBeLessThanOrEqual(0.99);
        expect(negativeConfidence(score, n / 50, balanced)).toBeGreaterThanOrEqual(0.5);
        expect(negativeConfidence(score, n / 50, balanced)).toBeLessThanOrEqual(0.99);
      }
    }
  });

  it('rises with evidence strength for a positive verdict', () => {
    const weak = positiveConfidence(0.6, 2, balanced);
    const strong = positiveConfidence(0.9, 2, balanced);
    expect(strong).toBeGreaterThan(weak);
  });

  it('rises with corroboration for a positive verdict', () => {
    const alone = positiveConfidence(0.85, 1, balanced);
    const corroborated = positiveConfidence(0.85, 4, balanced);
    expect(corroborated).toBeGreaterThan(alone);
  });

  it('is not merely the max frame score', () => {
    // A single 0.97 frame is a materially weaker case than four frames averaging 0.97, and
    // the number must reflect that rather than reporting the peak twice.
    const spike = positiveConfidence(0.97, 1, balanced);
    const sustained = positiveConfidence(0.97, 4, balanced);
    expect(spike).toBeLessThan(sustained);
  });

  it('penalises a clean verdict when coverage is poor', () => {
    // Same absence of evidence; very different amounts of looking.
    const barelyLooked = negativeConfidence(0, 0.01, balanced);
    const lookedEverywhere = negativeConfidence(0, 1, balanced);
    expect(barelyLooked).toBeLessThan(lookedEverywhere);
    expect(barelyLooked).toBeCloseTo(0.5 + 0.5 * (0.4 + 0.6 * 0.01), 6);
    expect(lookedEverywhere).toBe(0.99);
  });

  it('penalises a clean verdict when the peak frame was borderline', () => {
    const nothingSuspicious = negativeConfidence(0.05, 1, balanced);
    const almostFlagged = negativeConfidence(0.54, 1, balanced);
    expect(almostFlagged).toBeLessThan(nothingSuspicious);
  });

  it('produces a plausible headline number for a clear detection', () => {
    const out = aggregate({
      frames: [frame(1_000, 0.88), frame(5_000, 0.84), frame(9_000, 0.86), frame(20_000, 0.1)],
      policy: balanced,
      durationMs: 30_000,
    });
    expect(out.verdict.contains_inappropriate_content).toBe(true);
    expect(out.verdict.confidence).toBeGreaterThan(0.8);
    expect(out.verdict.confidence).toBeLessThan(0.95);
  });

  it('rounds confidence to two decimals, matching the specified payload shape', () => {
    const out = aggregate({ frames: [frame(1_000, 0.8123)], policy: strict, durationMs: 10_000 });
    expect(out.verdict.confidence).toBe(Math.round(out.verdict.confidence * 100) / 100);
  });
});

describe('buildSegments', () => {
  it('produces nothing when no frame is flagged', () => {
    expect(buildSegments([frame(1_000, 0.1)], balanced, 10_000)).toEqual([]);
  });

  it('merges nearby flagged frames into one padded segment', () => {
    const segments = buildSegments(
      [frame(5_000, 0.8), frame(6_000, 0.9), frame(6_500, 0.7)],
      balanced,
      60_000
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].startMs).toBe(4_400);
    expect(segments[0].endMs).toBe(7_100);
    expect(segments[0].peakScore).toBe(0.9);
    expect(segments[0].peakTsMs).toBe(6_000);
  });

  it('splits flagged frames separated by more than the merge gap', () => {
    const segments = buildSegments([frame(5_000, 0.8), frame(30_000, 0.8)], balanced, 60_000);
    expect(segments).toHaveLength(2);
  });

  it('clamps padding to the bounds of the video', () => {
    const segments = buildSegments([frame(100, 0.9), frame(29_900, 0.9)], balanced, 30_000);
    expect(segments[0].startMs).toBe(0);
    expect(segments[segments.length - 1].endMs).toBe(30_000);
  });
});

describe('shouldEarlyExit', () => {
  const at = (frames: FrameScore[]) => aggregate({ frames, policy: balanced, durationMs: 60_000 });

  it('never exits early on a negative verdict', () => {
    // Absence of evidence is exactly the case that needs MORE sampling, not less.
    expect(shouldEarlyExit(at([frame(1_000, 0.2)]), balanced)).toBe(false);
  });

  it('exits on a saturated single frame', () => {
    expect(shouldEarlyExit(at([frame(1_000, 0.995)]), balanced)).toBe(true);
  });

  it('exits on corroborated, comfortably-above-threshold evidence', () => {
    expect(
      shouldEarlyExit(at([frame(1_000, 0.9), frame(10_000, 0.88), frame(20_000, 0.91)]), balanced)
    ).toBe(true);
  });

  it('keeps scanning a borderline positive, where more samples still change the answer', () => {
    expect(shouldEarlyExit(at([frame(1_000, 0.57), frame(10_000, 0.58)]), balanced)).toBe(false);
  });
});
