import type { FitMode } from '../config';
import type { FrameSourceKind, SampledFrame, ScanErrorKind, VideoMeta } from '../types';

/**
 * Where frames come from.
 *
 * Two implementations exist, and which one is used is a genuine engineering decision rather
 * than "use the new API when available" - see {@link chooseFrameSourceKind}.
 */
export interface FrameSource {
  readonly kind: FrameSourceKind;

  /** Read duration/dimensions and, when possible, the keyframe index. */
  probe(signal?: AbortSignal): Promise<VideoMeta>;

  /**
   * Best available frame at or near `tsMs`, already downscaled to the model input size.
   *
   * Returns `null` when this particular timestamp cannot be produced (a failed seek, a decode
   * gap). One unreadable timestamp is expected on real media and must not abort a scan - the
   * sampler treats it as a failure and refines around it.
   *
   * The returned frame's `tsMs` is the ACTUAL timestamp delivered, which may differ from the
   * request: seeks land on frame boundaries, and the hardware path snaps within a GOP.
   */
  frameAt(tsMs: number, signal?: AbortSignal): Promise<SampledFrame | null>;

  close(): void;
}

export interface FrameSourceOptions {
  fit: FitMode;
  /** Model input edge length. */
  size: number;
}

/** A failure we can explain to the user in terms they can act on. */
export class ScanError extends Error {
  constructor(
    message: string,
    readonly kind: ScanErrorKind
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

/**
 * Beyond this, we do not attempt the WebCodecs path for an uploaded file.
 *
 * mp4box.js needs the whole byte range resident to resolve arbitrary sample offsets, so a
 * very large file would mean holding it all in memory - on a phone that is an OOM, not a slow
 * scan. The `<video>` element streams instead, so the fallback is strictly better here.
 */
export const WEBCODECS_MAX_BYTES = 300 * 1024 * 1024;

export interface SourceDecision {
  kind: FrameSourceKind;
  /** Shown in the UI: reviewers should be able to see which path ran and why. */
  reason: string;
}

/**
 * Pick a frame source.
 *
 * The non-obvious part: WebCodecs is NOT unconditionally better, and the reason is bandwidth
 * rather than compute.
 *
 *  - For an UPLOADED FILE the bytes are already local. Demuxing with mp4box and decoding with
 *    a hardware `VideoDecoder` is a pure win: no seek latency, no `<video>` pipeline overhead,
 *    and we get the keyframe index for free, which the sampler exploits.
 *
 *  - For a REMOTE URL it inverts. mp4box needs the entire file to resolve sample offsets, so
 *    the WebCodecs path would download the whole video - potentially hundreds of megabytes -
 *    to classify 120 frames. A `<video>` element issues HTTP range requests and fetches only
 *    the neighbourhoods it seeks to. Slower per frame, dramatically less network, and on a
 *    metered mobile connection that is the trade that actually matters.
 *
 * So: hardware decode for local files, streamed seeking for URLs. Any environment missing
 * WebCodecs or exceeding the memory ceiling falls back to the element path, which is
 * universally supported.
 */
export function chooseFrameSourceKind(input: {
  isLocalFile: boolean;
  byteLength: number | null;
  webcodecsAvailable: boolean;
  containerLikelyIsoBmff: boolean;
}): SourceDecision {
  const { isLocalFile, byteLength, webcodecsAvailable, containerLikelyIsoBmff } = input;

  if (!webcodecsAvailable) {
    return {
      kind: 'video-element',
      reason: 'WebCodecs is unavailable in this browser; using seek-based extraction.',
    };
  }
  if (!isLocalFile) {
    return {
      kind: 'video-element',
      reason:
        'Remote URL: streamed range requests fetch far less data than demuxing the whole file would.',
    };
  }
  if (!containerLikelyIsoBmff) {
    return {
      kind: 'video-element',
      reason: 'Container is not ISO-BMFF (MP4/MOV), which the demuxer does not handle.',
    };
  }
  if (byteLength !== null && byteLength > WEBCODECS_MAX_BYTES) {
    return {
      kind: 'video-element',
      reason: `File exceeds ${Math.round(WEBCODECS_MAX_BYTES / 1024 / 1024)} MB; streaming avoids holding it all in memory.`,
    };
  }
  return {
    kind: 'webcodecs',
    reason: 'Local ISO-BMFF file: hardware decode with a keyframe index.',
  };
}

/**
 * Sniff for an ISO-BMFF container by looking for an `ftyp` box near the start.
 *
 * Cheaper and far more reliable than trusting `File.type`, which is derived from the file
 * extension on most platforms and is wrong often enough to matter.
 */
export function looksLikeIsoBmff(head: ArrayBuffer): boolean {
  const bytes = new Uint8Array(head);
  // 'ftyp' at offset 4 is the overwhelmingly common case; scan a little further for the rest.
  for (let offset = 0; offset + 8 <= Math.min(bytes.length, 64); offset += 1) {
    if (
      bytes[offset + 4] === 0x66 && // f
      bytes[offset + 5] === 0x74 && // t
      bytes[offset + 6] === 0x79 && // y
      bytes[offset + 7] === 0x70 // p
    ) {
      return true;
    }
  }
  return false;
}
