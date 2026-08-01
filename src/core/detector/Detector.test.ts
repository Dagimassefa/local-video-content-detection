import { describe, expect, it } from 'vitest';
import {
  CATEGORY_META,
  CONTENT_CATEGORIES,
  screenedCategories,
  unscreenedCategories,
  type CategoryScores,
} from '../categories';
import { POLICIES, type Policy } from '../config';
import { combineCategoryScores, mergeDetectorResults, type DetectorResult } from './Detector';

const balanced = POLICIES.balanced;

const withCategoryWeights = (
  weights: NonNullable<Policy['categoryWeights']>
): Policy => ({ ...balanced, categoryWeights: weights });

describe('combineCategoryScores', () => {
  it('is zero when nothing was screened', () => {
    expect(combineCategoryScores({}, balanced)).toBe(0);
  });

  it('takes the WORST category, not the sum or the mean', () => {
    // The question is "is there anything inappropriate in this frame". A frame that is confidently
    // violent and confidently non-sexual is exactly as unsafe as one that is confidently sexual.
    const scores: CategoryScores = { sexual: 0.05, violence: 0.9 };
    expect(combineCategoryScores(scores, balanced)).toBe(0.9);
  });

  it('does not let a clean category dilute a genuine detection', () => {
    // Averaging would give 0.475 here and fall below the 0.55 threshold, hiding a real detection -
    // the same failure mode `mergeCropScores` avoids for crops.
    const scores: CategoryScores = { sexual: 0.95, violence: 0.0 };
    const combined = combineCategoryScores(scores, balanced);
    expect(combined).toBe(0.95);
    expect(combined).toBeGreaterThan(balanced.frameThreshold);
  });

  it('does not let two mild unrelated signals manufacture a strong one', () => {
    // Summing would give 0.8 and cross the threshold on no real evidence at all.
    const scores: CategoryScores = { sexual: 0.4, violence: 0.4 };
    expect(combineCategoryScores(scores, balanced)).toBe(0.4);
    expect(combineCategoryScores(scores, balanced)).toBeLessThan(balanced.frameThreshold);
  });

  it('applies per-category weights so a policy can discount a category', () => {
    const scores: CategoryScores = { sexual: 0.8 };
    const halfWeight = withCategoryWeights({ sexual: 0.5 });
    expect(combineCategoryScores(scores, halfWeight)).toBeCloseTo(0.4, 6);
  });

  it('defaults an unlisted category to full weight', () => {
    // A newly registered detector must count fully unless a policy deliberately discounts it -
    // silently ignoring a new category would be the worst possible default for a safety system.
    const policy = withCategoryWeights({ sexual: 1 });
    expect(combineCategoryScores({ violence: 0.9 }, policy)).toBe(0.9);
  });

  it('lets a policy suppress a category entirely with weight zero', () => {
    const policy = withCategoryWeights({ violence: 0 });
    expect(combineCategoryScores({ violence: 1, sexual: 0.1 }, policy)).toBeCloseTo(0.1, 6);
  });

  it('stays within [0, 1] for out-of-range inputs', () => {
    expect(combineCategoryScores({ sexual: 5 }, balanced)).toBe(1);
    expect(combineCategoryScores({ sexual: -3 }, balanced)).toBe(0);
  });

  it('ignores NaN rather than propagating it', () => {
    // A NaN reaching the aggregator would poison every comparison downstream and silently disable
    // the threshold checks.
    const combined = combineCategoryScores({ sexual: Number.NaN, violence: 0.7 }, balanced);
    expect(combined).toBe(0.7);
  });
});

describe('mergeDetectorResults', () => {
  const nsfw: DetectorResult = {
    categories: { sexual: 0.8 },
    detail: { Drawing: 0, Hentai: 0, Neutral: 0.2, Porn: 0.8, Sexy: 0 },
  };
  const hypothetical: DetectorResult = { categories: { violence: 0.3, gore: 0.1 } };

  it('unions the categories from several detectors', () => {
    const merged = mergeDetectorResults([nsfw, hypothetical]);
    expect(merged.categories).toEqual({ sexual: 0.8, violence: 0.3, gore: 0.1 });
  });

  it('keeps the highest score when two detectors cover the same category', () => {
    // An ensemble should not be able to talk itself down: if either member sees something, the
    // frame is suspicious.
    const merged = mergeDetectorResults([{ categories: { sexual: 0.2 } }, { categories: { sexual: 0.9 } }]);
    expect(merged.categories.sexual).toBe(0.9);
  });

  it('preserves model-native detail for display', () => {
    expect(mergeDetectorResults([nsfw, hypothetical]).detail?.Porn).toBe(0.8);
  });

  it('is a no-op for a single detector', () => {
    expect(mergeDetectorResults([nsfw])).toEqual(nsfw);
  });

  it('produces no categories at all when given nothing', () => {
    // Crucially NOT "all categories are zero" - that would assert cleanliness we never established.
    expect(mergeDetectorResults([]).categories).toEqual({});
  });

  it('composes end to end: two detectors, one frame, one score', () => {
    const merged = mergeDetectorResults([nsfw, hypothetical]);
    const score = combineCategoryScores(merged.categories, balanced);
    expect(score).toBe(0.8);
    expect(score).toBeGreaterThan(balanced.frameThreshold);
  });
});

describe('content taxonomy', () => {
  it('declares exactly one screened category in this build', () => {
    // If a detector is added and this is not updated, the payload would under-report coverage.
    expect(screenedCategories()).toEqual(['sexual']);
  });

  it('declares the rest as explicitly unscreened', () => {
    const unscreened = unscreenedCategories();
    expect(unscreened).toContain('violence');
    expect(unscreened).toContain('gore');
    expect(unscreened).toContain('self-harm');
    expect(screenedCategories().length + unscreened.length).toBe(CONTENT_CATEGORIES.length);
  });

  it('never overlaps screened and unscreened', () => {
    const screened = new Set(screenedCategories());
    expect(unscreenedCategories().some((c) => screened.has(c))).toBe(false);
  });

  it('documents every category, and says what each unscreened one needs', () => {
    // The point of the taxonomy is that a gap is stated rather than implied. An unscreened category
    // with no explanation is just an undocumented gap wearing a type.
    for (const category of CONTENT_CATEGORIES) {
      const meta = CATEGORY_META[category];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      if (!meta.screened) expect(meta.requires && meta.requires.length > 0).toBe(true);
    }
  });

  it('treats an absent category as UNKNOWN, never as clean', () => {
    // The single most important property of the taxonomy. If `violence` being absent from a frame's
    // scores read as "violence: 0", a caller would conclude a video was screened for violence and
    // found clean, when it was never examined at all.
    const scores: CategoryScores = { sexual: 0.1 };
    expect('violence' in scores).toBe(false);
    expect(scores.violence).toBeUndefined();
    // And it must not contribute to the frame score in either direction.
    expect(combineCategoryScores(scores, balanced)).toBe(0.1);
  });
});
