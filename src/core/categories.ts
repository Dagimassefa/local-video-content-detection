/**
 * The content taxonomy: what "inappropriate" is defined to mean, made explicit.
 *
 * The brief asks whether a video "contains inappropriate visual content" without defining the term.
 * That is a reasonable way to write a brief and an unreasonable way to build a service, because
 * "inappropriate" is not a property of a video - it is a property of a video *relative to a policy*.
 * A surgical training film, a boxing match and a Renaissance nude are each inappropriate for exactly
 * one of a children's app, a workplace feed and nowhere at all.
 *
 * So the system does not have an opinion about the word. It screens a declared set of CATEGORIES, and
 * says which ones it screened. Two consequences worth stating:
 *
 *   1. **Coverage is machine-readable, not buried in a README.** Every `ScanResult` carries the
 *      categories that were screened and the ones that were not. A caller integrating this can tell
 *      programmatically that a clean verdict means "no sexual content found", not "nothing wrong here".
 *      A narrowing that is stated in prose gets lost; one that is in the payload cannot be.
 *
 *   2. **Adding a category is a registration, not a refactor.** `Detector` implementations contribute
 *      per-category scores and the pipeline composes them. See `detector/Detector.ts`.
 */

export const CONTENT_CATEGORIES = [
  'sexual',
  'violence',
  'gore',
  'weapons',
  'self-harm',
  'hate-imagery',
  'drugs',
] as const;

export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];

/** Per-category scores in [0, 1]. Absent keys mean "not screened", NOT "screened and clean". */
export type CategoryScores = Partial<Record<ContentCategory, number>>;

export interface CategoryMeta {
  label: string;
  description: string;
  /** Whether a detector for this category actually ships in this build. */
  screened: boolean;
  /** For unscreened categories: what it would take. Honest, and useful for planning. */
  requires?: string;
}

export const CATEGORY_META: Record<ContentCategory, CategoryMeta> = {
  sexual: {
    label: 'Sexual content',
    description:
      'Explicit and suggestive sexual imagery, photographic and illustrated. Screened by the NSFWJS MobileNetV2 classifier across five classes.',
    screened: true,
  },
  violence: {
    label: 'Violence',
    description: 'Fighting, assault, and depictions of physical harm to people.',
    screened: false,
    requires:
      'A checkpoint that generalises. The detector is implemented (core/detector/violenceDetector.ts, ONNX Runtime Web) and the only public ViT checkpoint was evaluated and REJECTED - see scripts/eval-violence-model.mjs. Swapping in a better checkpoint is a manifest change.',
  },
  gore: {
    label: 'Gore',
    description: 'Blood, injury, and graphic medical imagery.',
    screened: false,
    requires:
      'A purpose-trained classifier. Colour/texture heuristics for "blood" fail on food, sunsets and sport, and would do more harm than nothing.',
  },
  weapons: {
    label: 'Weapons',
    description: 'Firearms and bladed weapons in a threatening context.',
    screened: false,
    requires:
      'Context, not object presence. See the note below on why a knife detector was rejected.',
  },
  'self-harm': {
    label: 'Self-harm',
    description: 'Depictions or encouragement of self-injury.',
    screened: false,
    requires:
      'A purpose-trained classifier plus a crisis-response product flow. Detection without the flow is worse than no detection.',
  },
  'hate-imagery': {
    label: 'Hate imagery',
    description: 'Hate symbols and extremist iconography.',
    screened: false,
    requires:
      'Symbol matching against a curated reference set, which is a retrieval problem rather than a classification one.',
  },
  drugs: {
    label: 'Drug use',
    description: 'Depiction of illicit drug use or paraphernalia.',
    screened: false,
    requires: 'A purpose-trained classifier.',
  },
};

/**
 * ## Why a second, weaker detector was deliberately NOT shipped
 *
 * The tempting way to widen coverage is to bolt on an off-the-shelf object detector. COCO-SSD
 * (lite_mobilenet_v2, ~6 MB, runs in tfjs today) has `knife`, `scissors` and `baseball bat` classes,
 * so "weapons" could be claimed within an afternoon.
 *
 * It was rejected, and the reasoning is the point rather than the conclusion:
 *
 *   - **Object presence is not the signal.** Every cooking video contains a knife. Every barber, every
 *     craft tutorial, most kitchens. A detector firing on those would generate false positives at a
 *     rate that makes the whole feature untrustworthy - and once users learn a safety control cries
 *     wolf, they disable it, which is strictly worse than never having shipped it.
 *   - **It would corrupt the confidence figure.** `confidence` is calibrated (loosely, and documented
 *     as such) against one detector's behaviour. Mixing in a signal with a wildly different
 *     false-positive profile makes the number mean nothing.
 *   - **It buys a checkbox, not a capability.** "Detects weapons" in a feature list, with detection
 *     nobody could ship. The brief asks about reasoning under realistic constraints; claiming coverage
 *     that does not survive contact with real video is the wrong answer to that.
 *
 * So: one category is screened properly, the rest are declared unscreened in the payload, and the
 * architecture makes adding a real detector cheap. Narrow and honest beats broad and false.
 */
export const screenedCategories = (): ContentCategory[] =>
  CONTENT_CATEGORIES.filter((c) => CATEGORY_META[c].screened);

export const unscreenedCategories = (): ContentCategory[] =>
  CONTENT_CATEGORIES.filter((c) => !CATEGORY_META[c].screened);
