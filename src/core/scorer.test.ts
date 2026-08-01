import { describe, expect, it } from 'vitest';
import { POLICIES } from './config';
import {
  classScoresFromPredictions,
  classScoresFromVector,
  dominantClass,
  frameScore,
  mergeCropScores,
} from './scorer';
import { NSFW_CLASS_NAMES, type ClassScores } from './types';

const dist = (
  Drawing: number,
  Hentai: number,
  Neutral: number,
  Porn: number,
  Sexy: number
): ClassScores => ({ Drawing, Hentai, Neutral, Porn, Sexy });

describe('frameScore', () => {
  it('scores a confidently neutral frame at zero under every profile', () => {
    const neutral = dist(0, 0, 1, 0, 0);
    for (const policy of Object.values(POLICIES)) {
      expect(frameScore(neutral, policy)).toBe(0);
    }
  });

  it('scores a confidently explicit frame at one under every profile', () => {
    const explicit = dist(0, 0, 0, 1, 0);
    for (const policy of Object.values(POLICIES)) {
      expect(frameScore(explicit, policy)).toBe(1);
    }
  });

  it('stays within [0, 1] because the weights ride on a softmax', () => {
    // No renormalisation anywhere in the pipeline depends on luck: the class probabilities
    // sum to 1 and every weight is <= 1, so the weighted sum is bounded by construction.
    const spread = dist(0.2, 0.2, 0.2, 0.2, 0.2);
    for (const policy of Object.values(POLICIES)) {
      const score = frameScore(spread, policy);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('weights suggestive content differently across profiles - the product decision', () => {
    const suggestive = dist(0, 0, 0.2, 0, 0.8);
    const strict = frameScore(suggestive, POLICIES.strict);
    const balanced = frameScore(suggestive, POLICIES.balanced);
    const permissive = frameScore(suggestive, POLICIES.permissive);
    expect(strict).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(permissive);

    // And the practical consequence: the same frame crosses the line for a child-safety
    // posture and does not for an adult platform.
    expect(strict).toBeGreaterThanOrEqual(POLICIES.strict.frameThreshold);
    expect(permissive).toBeLessThan(POLICIES.permissive.frameThreshold);
  });

  it('treats illustrated explicit content as explicit', () => {
    const hentai = dist(0, 0.9, 0.1, 0, 0);
    expect(frameScore(hentai, POLICIES.balanced)).toBeGreaterThan(
      POLICIES.balanced.frameThreshold
    );
  });

  it('does not penalise safe artwork under the balanced profile', () => {
    const drawing = dist(0.95, 0, 0.05, 0, 0);
    expect(frameScore(drawing, POLICIES.balanced)).toBe(0);
  });

  it('is monotone in the unsafe probability mass', () => {
    const policy = POLICIES.balanced;
    let previous = -1;
    for (const porn of [0, 0.25, 0.5, 0.75, 1]) {
      const score = frameScore(dist(0, 0, 1 - porn, porn, 0), policy);
      expect(score).toBeGreaterThan(previous);
      previous = score;
    }
  });
});

describe('classScoresFromVector', () => {
  it('maps the model output vector onto class names in head order', () => {
    const scores = classScoresFromVector([0.1, 0.2, 0.3, 0.25, 0.15]);
    expect(scores).toEqual(dist(0.1, 0.2, 0.3, 0.25, 0.15));
  });

  it('rejects a vector of the wrong length rather than mis-assigning classes', () => {
    // Silently mislabelling classes would produce plausible-looking but meaningless verdicts,
    // which is far worse than a loud failure.
    expect(() => classScoresFromVector([0.5, 0.5])).toThrow(/5 class probabilities/);
  });

  it('agrees with the documented class order', () => {
    expect([...NSFW_CLASS_NAMES]).toEqual(['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);
  });
});

describe('classScoresFromPredictions', () => {
  it('re-keys nsfwjs output by name rather than by position', () => {
    // nsfwjs sorts `classify()` results by descending probability, so reading them
    // positionally would scramble the classes on every single frame.
    const scores = classScoresFromPredictions([
      { className: 'Porn', probability: 0.7 },
      { className: 'Neutral', probability: 0.2 },
      { className: 'Sexy', probability: 0.1 },
    ]);
    expect(scores.Porn).toBe(0.7);
    expect(scores.Neutral).toBe(0.2);
    expect(scores.Sexy).toBe(0.1);
    expect(scores.Drawing).toBe(0);
    expect(scores.Hentai).toBe(0);
  });

  it('ignores unknown class names', () => {
    const scores = classScoresFromPredictions([{ className: 'Nonsense', probability: 0.9 }]);
    expect(Object.values(scores).every((v) => v === 0)).toBe(true);
  });
});

describe('dominantClass', () => {
  it('picks the highest-probability class', () => {
    expect(dominantClass(dist(0.1, 0.1, 0.2, 0.5, 0.1))).toBe('Porn');
  });

  it('breaks ties deterministically in head order', () => {
    expect(dominantClass(dist(0.5, 0.5, 0, 0, 0))).toBe('Drawing');
  });
});

describe('mergeCropScores', () => {
  it('takes the per-class max, not the mean', () => {
    // A crop that missed the content returns a confidently-Neutral distribution. Averaging it
    // against a confidently-Porn one pushes both below threshold, defeating the entire point
    // of evaluating multiple crops.
    const missed = dist(0, 0, 0.98, 0.01, 0.01);
    const hit = dist(0, 0, 0.05, 0.92, 0.03);
    const merged = mergeCropScores([missed, hit]);
    expect(merged.Porn).toBe(0.92);
    expect(frameScore(merged, POLICIES.balanced)).toBeGreaterThan(
      POLICIES.balanced.frameThreshold
    );
    // Whereas the mean would have hidden it:
    expect((missed.Porn + hit.Porn) / 2).toBeLessThan(POLICIES.balanced.frameThreshold);
  });

  it('is a no-op for a single crop', () => {
    const only = dist(0.1, 0.2, 0.3, 0.25, 0.15);
    expect(mergeCropScores([only])).toEqual(only);
  });

  it('rejects an empty crop list', () => {
    expect(() => mergeCropScores([])).toThrow();
  });
});
