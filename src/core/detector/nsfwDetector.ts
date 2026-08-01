import type { ContentCategory } from '../categories';
import type { Policy } from '../config';
import type { Classifier } from '../classifier/Classifier';
import { NsfwjsClassifier } from '../classifier/nsfwjs';
import { frameScore } from '../scorer';
import type { BackendInfo, BackendPref } from '../types';
import type { Detector, DetectorResult } from './Detector';

/**
 * The sexual-content detector: adapts the NSFWJS five-class classifier to the category interface.
 *
 * Thin on purpose. All it does is apply the active policy's class weights to the model's output and
 * publish the result under one category. The policy weighting stays in `scorer.ts` rather than moving
 * in here, because how much a `Sexy` frame counts relative to a `Porn` frame is a product decision that
 * belongs with the other product decisions — not buried in a model adapter.
 */
export class NsfwDetector implements Detector {
  readonly id = 'nsfw-mobilenet-v2';
  readonly categories: readonly ContentCategory[] = ['sexual'];

  constructor(private readonly classifier: Classifier = new NsfwjsClassifier()) {}

  init(pref: BackendPref, signal?: AbortSignal): Promise<BackendInfo> {
    return this.classifier.init(pref, signal);
  }

  async score(bitmap: ImageBitmap, policy: Policy): Promise<DetectorResult> {
    const classes = await this.classifier.classify(bitmap);
    return {
      categories: { sexual: frameScore(classes, policy) },
      detail: classes,
    };
  }

  memory(): { numTensors: number; numBytes: number } | undefined {
    return this.classifier.memory?.();
  }

  dispose(): void {
    this.classifier.dispose();
  }
}
