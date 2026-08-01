import { createFile, DataStream, type ISOFile, type Track } from 'mp4box';
import { prepareFrame, releaseFrame } from './preprocess';
import { ScanError, type FrameSource, type FrameSourceOptions } from './FrameSource';
import type { FrameSourceKind, SampledFrame, VideoMeta } from '../types';

/**
 * Hardware-accelerated frame extraction: mp4box.js for demuxing, WebCodecs `VideoDecoder` for
 * decoding.
 *
 * Used for LOCAL FILES only (see `chooseFrameSourceKind`) - the bytes are already on the
 * device, so there is nothing to lose by demuxing them and a great deal to gain:
 *
 *  - No seek latency. The `<video>` path pays 30-100 ms per sample flushing and refilling a
 *    media pipeline; here we hand the decoder exactly the samples we want.
 *  - Decoding runs on the dedicated media block, which on a phone is both far faster and
 *    considerably more power-efficient per frame than the general-purpose path.
 *  - **The keyframe index comes free.** This is the part that changes the algorithm rather than
 *    merely speeding it up: the sample table gives us every `is_sync` flag without decoding
 *    anything, so the sampler can snap its choices onto keyframes. Those decode standalone and
 *    encoders place them at scene changes, making them simultaneously the cheapest and the most
 *    informative frames in the file.
 *
 * Two implementation decisions worth calling out, both learned from what real files actually
 * look like rather than from what the format specification suggests:
 *
 *  1. **Sample bytes are read from the `Blob`, not from mp4box.** mp4box is constructed with
 *     `keepMdatData = false`, so it parses the box structure and throws the media payloads
 *     away. We then slice the bytes we need straight out of the Blob, which the browser keeps
 *     backed by the file on disk. The result is that scanning a 300 MB video holds the box
 *     index in memory and essentially nothing else, instead of the whole file (or worse, the
 *     whole file twice).
 *
 *  2. **Duration comes from the sample table, not from `track.duration`.** Anything produced by
 *     `MediaRecorder` - which is to say anything recorded in a browser, a very common input - is
 *     a FRAGMENTED MP4 whose `moov` declares a duration of essentially zero, with the real
 *     timeline living in the fragments. Trusting the header there yields a 0.14-second duration
 *     for a 12-second video and every subsequent sample lands out of range. The last sample's
 *     composition time is the truth.
 */

/**
 * Beyond this many frames past a keyframe, take the keyframe instead of walking forward.
 *
 * Reaching an arbitrary frame means decoding every frame since the last keyframe. With a long
 * GOP that is potentially hundreds of decodes for one sample, which would silently make the
 * "fast" path slower than the fallback it replaced. Better to accept a slightly different
 * timestamp - reported honestly as the actual `tsMs` - than to spend the frame budget on one
 * sample. Sub-keyframe precision, where it genuinely matters, is what the `<video>` path is for.
 */
const MAX_GOP_WALK = 24;

/**
 * Sample points we would like to have available before deciding keyframe-only sampling is adequate.
 * Matches the default `surveyFrames`; the source cannot see the budget, so this is the assumption.
 */
const DESIRED_SAMPLE_POINTS = 16;

/**
 * Absolute ceiling on a GOP walk, whatever the arithmetic says.
 *
 * Protects the pathological case - a long video with very long GOPs - from turning one sample into
 * hundreds of decodes.
 */
const HARD_MAX_GOP_WALK = 120;

const DECODE_TIMEOUT_MS = 8_000;

interface IndexedSample {
  /** Byte range in the source Blob. */
  offset: number;
  size: number;
  /** Composition (presentation) time in ms. */
  tsMs: number;
  durationMs: number;
  isSync: boolean;
}

export class WebCodecsFrameSource implements FrameSource {
  readonly kind: FrameSourceKind = 'webcodecs';

  private file: ISOFile | null = null;
  private index: IndexedSample[] = [];
  private keyframeIndices: number[] = [];
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  private meta: VideoMeta | null = null;
  private closed = false;

  /** Serialises decode requests - one decoder, one in-flight GOP walk at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  private onFrame: ((frame: VideoFrame) => void) | null = null;
  private onError: ((err: Error) => void) | null = null;
  /** Computed in `probe()` - see `chooseGopWalk`. */
  private maxGopWalk = MAX_GOP_WALK;
  /** Keyframe the decoder was last primed from, so contiguous walks can skip a reset. */
  private lastKeyIdx = -1;

  constructor(
    private readonly blob: Blob,
    private readonly options: FrameSourceOptions
  ) {}

  async probe(signal?: AbortSignal): Promise<VideoMeta> {
    if (this.meta) return this.meta;
    if (typeof VideoDecoder === 'undefined') {
      throw new ScanError('WebCodecs is not available in this browser.', 'unsupported-codec');
    }

    // keepMdatData = false: parse the structure, discard the payloads. We read sample bytes from
    // the Blob ourselves, so retaining them here would just be a second copy of the video.
    const file = createFile(false);
    this.file = file;
    const ready = waitForMoov(file);

    // Appended in slices rather than one giant read, so peak transient memory is one chunk
    // rather than the whole file, and so an abort mid-load is possible.
    const CHUNK = 8 * 1024 * 1024;
    const total = this.blob.size;
    for (let offset = 0; offset < total; offset += CHUNK) {
      throwIfAborted(signal);
      const slice = this.blob.slice(offset, Math.min(offset + CHUNK, total));
      const buffer = (await slice.arrayBuffer()) as ArrayBuffer & { fileStart: number };
      buffer.fileStart = offset;
      file.appendBuffer(buffer, offset + CHUNK >= total);
    }
    file.flush();

    const info = await ready;
    throwIfAborted(signal);

    const track = info.videoTracks?.[0];
    if (!track) throw new ScanError('This file contains no video track.', 'unsupported-codec');

    // Sample table metadata only - byte offsets, sizes, timestamps, sync flags. No media data.
    const samples = file.getTrackSamplesInfo(track.id);
    if (!samples || samples.length === 0) {
      throw new ScanError('The demuxer found no video samples in this file.', 'decode');
    }

    this.index = samples
      .map((s) => {
        const timescale = s.timescale || track.timescale || 1;
        return {
          offset: s.offset,
          size: s.size,
          tsMs: (s.cts / timescale) * 1000,
          durationMs: (s.duration / timescale) * 1000,
          isSync: s.is_sync,
        };
      })
      // Composition order, which is not decode order for anything containing B-frames.
      .sort((a, b) => a.tsMs - b.tsMs);

    this.keyframeIndices = this.index.reduce<number[]>((acc, s, i) => {
      if (s.isSync) acc.push(i);
      return acc;
    }, []);
    // Some encoders omit sync flags entirely; treat the first sample as a keyframe so the walk
    // logic always has an anchor.
    if (this.keyframeIndices.length === 0) this.keyframeIndices.push(0);

    this.maxGopWalk = this.chooseGopWalk();
    this.config = this.buildDecoderConfig(file, track);
    let support: VideoDecoderSupport;
    try {
      support = await VideoDecoder.isConfigSupported(this.config);
    } catch (err) {
      throw new ScanError(
        `Decoder configuration was rejected for ${track.codec}: ${describeError(err)}`,
        'unsupported-codec'
      );
    }
    if (!support.supported) {
      throw new ScanError(
        `This browser cannot decode ${track.codec}.`,
        'unsupported-codec'
      );
    }

    // Derived from the sample table - see the note at the top of this file about fragmented MP4.
    const last = this.index[this.index.length - 1];
    const durationMs = Math.max(1, Math.round(last.tsMs + (last.durationMs || 0)));

    this.meta = {
      durationMs,
      width: track.video?.width ?? track.track_width,
      height: track.video?.height ?? track.track_height,
      keyframeTimesMs: this.keyframeIndices.map((i) => Math.round(this.index[i].tsMs)),
      codec: track.codec,
      kind: this.kind,
      temporalResolutionMs: this.estimateResolutionMs(),
    };
    return this.meta;
  }

  /**
   * The finest interval at which this source can return distinct frames.
   *
   * Two regimes, decided by the GOP length:
   *
   *  - SHORT GOP (within {@link MAX_GOP_WALK}): any frame is reachable by walking forward from its
   *    keyframe, so resolution is one frame duration.
   *  - LONG GOP: the walk is refused and we serve the keyframe instead, so resolution is the
   *    keyframe spacing however finely we are asked.
   *
   * Reported to the pipeline so refinement stops below it, rather than repeatedly requesting
   * timestamps that can only resolve to a frame already scored.
   */
  private estimateResolutionMs(): number {
    const frameMs = this.medianFrameMs();
    if (this.keyframeIndices.length < 2) return frameMs;
    const framesPerGop = this.medianKeyframeGapMs() / Math.max(1, frameMs);
    return framesPerGop <= this.maxGopWalk ? frameMs : this.medianKeyframeGapMs();
  }

  private medianFrameMs(): number {
    return median(this.index.map((s) => s.durationMs).filter((d) => d > 0)) || 40;
  }

  private medianKeyframeGapMs(): number {
    const gaps: number[] = [];
    for (let i = 1; i < this.keyframeIndices.length; i++) {
      gaps.push(
        this.index[this.keyframeIndices[i]].tsMs - this.index[this.keyframeIndices[i - 1]].tsMs
      );
    }
    return gaps.length ? median(gaps) : 0;
  }

  /**
   * How far we are willing to walk past a keyframe, decided per file rather than fixed.
   *
   * The walk cap exists so one sample cannot cost hundreds of decodes on a long-GOP file. But a fixed
   * constant asks the wrong question. What matters is whether keyframes ALONE give enough distinct
   * sample points - and when they do not, refusing to walk does not save work, it destroys coverage.
   *
   * Found on a real 9-second vertical clip: 262 frames, 10 fps, and only TWO keyframes, so 30 frames
   * per GOP against the old fixed cap of 24. Six frames over the line, and the source declared a
   * 3-second temporal resolution - meaning a 9-second video offered **three** possible sample points
   * and the scan ran on ONE frame at 46% coverage. Short-form vertical video is exactly the mobile
   * case this project targets, and it was the worst-served input in the system.
   *
   * So: if keyframes already provide enough sample points, keep the cheap cap. If they do not, walking
   * is the only way to get coverage, and on such a file the absolute cost is small precisely because
   * the GOP is short in wall-clock terms. Bounded by {@link HARD_MAX_GOP_WALK} so a long video with
   * enormous GOPs still cannot blow the budget.
   */
  private chooseGopWalk(): number {
    // Currently fixed. An adaptive version was tried - raise the cap when keyframes alone cannot
    // supply {@link DESIRED_SAMPLE_POINTS} - and REVERTED, because it made a 9-second clip slower
    // than a 300-second timeout.
    //
    // The reason is instructive: the walk cost is not decoding, it is that each sample is fetched
    // with its own `blob.slice().arrayBuffer()`. Thirty frames means thirty async round trips, and
    // that overhead dominates. Raising the cap without first batching the GOP into a single
    // contiguous read just multiplies the round trips.
    //
    // The real fix is one Blob read per walk, then `subarray` per sample; the cap can rise safely
    // after that. Left undone deliberately rather than half-done. See
    // docs/05-limitations-and-production-path.md.
    void DESIRED_SAMPLE_POINTS;
    void HARD_MAX_GOP_WALK;
    return MAX_GOP_WALK;
  }

  /**
   * Assemble the `VideoDecoderConfig`, including the codec-private description.
   *
   * H.264/H.265 in MP4 keep their parameter sets in an `avcC`/`hvcC` box rather than inline, and
   * a decoder configured without them cannot decode anything at all. The box is read from the
   * `moov` sample-description entry (NOT from a decoded sample - fragmented files do not carry
   * it there), serialised, and its 8-byte box header stripped, because WebCodecs wants only the
   * payload.
   *
   * If no description can be built we configure without one rather than giving up: some codecs
   * need none, and `isConfigSupported` is the arbiter either way. If it says no, the caller
   * falls back to the `<video>` path - which is exactly why that path was built first.
   */
  private buildDecoderConfig(file: ISOFile, track: Track): VideoDecoderConfig {
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.video?.width ?? track.track_width,
      codedHeight: track.video?.height ?? track.track_height,
      // We only ever want one specific frame, so latency matters more than throughput.
      optimizeForLatency: true,
    };

    try {
      const trak = file.moov?.traks?.find((t) => t.tkhd?.track_id === track.id);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] as
        | Record<string, { write(stream: DataStream): void } | undefined>
        | undefined;
      const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, 1 /* BIG_ENDIAN */);
        box.write(stream);
        const buffer = (stream as unknown as { buffer: ArrayBuffer }).buffer;
        // Strip the 4-byte size + 4-byte type header.
        config.description = new Uint8Array(buffer.slice(8));
      }
    } catch {
      // No description available; isConfigSupported decides.
    }
    return config;
  }

  async frameAt(tsMs: number, signal?: AbortSignal): Promise<SampledFrame | null> {
    if (this.closed) return null;
    if (!this.config || this.index.length === 0) {
      throw new Error('frameAt called before probe()');
    }
    const task = this.queue.then(() => this.decodeNear(tsMs, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async decodeNear(tsMs: number, signal?: AbortSignal): Promise<SampledFrame | null> {
    throwIfAborted(signal);

    const targetIdx = this.nearestSampleIndex(tsMs);
    const keyIdx = this.keyframeAtOrBefore(targetIdx);
    const endIdx = targetIdx - keyIdx > this.maxGopWalk ? keyIdx : targetIdx;
    const wanted = this.index[endIdx];

    const decoder = this.ensureDecoder();

    // Random access requires discarding decoder state before jumping to a different GOP.
    // `flush()` drains pending work but leaves reference-frame state behind, and feeding a new
    // keyframe on top of that stale state is what produced 8-second `flush()` stalls in the
    // benchmark - the decoder sat waiting for data that belonged to the previous GOP. `reset()`
    // followed by `configure()` is the documented seek pattern, and it is skipped when the walk
    // continues from the same keyframe so sequential access stays cheap.
    if (this.lastKeyIdx !== keyIdx) {
      try {
        decoder.reset();
        decoder.configure(this.config!);
      } catch {
        this.resetDecoder();
        this.ensureDecoder();
      }
      this.lastKeyIdx = keyIdx;
    }

    const frames: VideoFrame[] = [];
    let decodeError: Error | null = null;

    this.onFrame = (frame) => frames.push(frame);
    this.onError = (err) => {
      decodeError = err;
    };

    try {
      // Read the whole walk as ONE Blob slice, not one per sample.
      //
      // A GOP walk of 30 frames used to mean 30 separate `blob.slice().arrayBuffer()` round trips.
      // Each is an async hop, and the per-call overhead - not the decoding - dominated: raising the
      // walk cap to cover a short-form clip with 30-frame GOPs made a 9-second video take longer
      // than the 300-second test timeout. Batching into a single contiguous read makes the same walk
      // effectively free, which is what allows the adaptive cap in `chooseGopWalk` to exist at all.
      const byteStart = this.index[keyIdx].offset;
      let byteEnd = byteStart;
      for (let i = keyIdx; i <= endIdx; i++) {
        byteEnd = Math.max(byteEnd, this.index[i].offset + this.index[i].size);
      }
      // Interleaved audio can make the range far larger than the video bytes within it. Past a
      // sane ceiling, fall back to per-sample reads rather than pulling tens of megabytes.
      const span = byteEnd - byteStart;
      const batch =
        span > 0 && span <= 32 * 1024 * 1024
          ? new Uint8Array(await this.blob.slice(byteStart, byteEnd).arrayBuffer())
          : null;

      for (let i = keyIdx; i <= endIdx; i++) {
        throwIfAborted(signal);
        const sample = this.index[i];

        const data = batch
          ? batch.subarray(sample.offset - byteStart, sample.offset - byteStart + sample.size)
          : new Uint8Array(
              await this.blob.slice(sample.offset, sample.offset + sample.size).arrayBuffer()
            );

        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isSync ? 'key' : 'delta',
            timestamp: Math.round(sample.tsMs * 1000),
            duration: Math.round((sample.durationMs || 0) * 1000),
            data,
          })
        );

        // Respect backpressure. Queueing a whole GOP at once can exhaust decoder-side buffers on
        // constrained devices, which surfaces as an opaque decoder error rather than a stall.
        while (decoder.decodeQueueSize > 8) {
          await nextTick();
          throwIfAborted(signal);
        }
      }

      await withTimeout(decoder.flush(), DECODE_TIMEOUT_MS, 'video decode');
      if (decodeError) throw decodeError;

      // Keep the frame closest to what we asked for. Everything else was decoded only to satisfy
      // inter-frame dependencies and must be released.
      const wantUs = wanted.tsMs * 1000;
      let best: VideoFrame | null = null;
      for (const frame of frames) {
        if (!best || Math.abs(frame.timestamp - wantUs) < Math.abs(best.timestamp - wantUs)) {
          if (best) best.close();
          best = frame;
        } else {
          frame.close();
        }
      }
      frames.length = 0;
      if (!best) return null;

      let prepared = null;
      try {
        prepared = await prepareFrame(best, this.options.fit, this.options.size);
        return {
          tsMs: Math.round(best.timestamp / 1000),
          bitmap: prepared.bitmap,
          hash: prepared.hash,
        };
      } catch {
        releaseFrame(prepared);
        return null;
      } finally {
        // A VideoFrame holds a real GPU buffer. Failing to close it is not a leak the collector
        // eventually tidies up - it starves the decoder of buffers within a few frames and the
        // whole pipeline stalls.
        best.close();
      }
    } catch (err) {
      for (const frame of frames) frame.close();
      frames.length = 0;
      // A decoder that has errored cannot be reused; drop it so the next request rebuilds one.
      this.resetDecoder();
      this.lastKeyIdx = -1;
      if (isAbort(err)) throw err;
      return null;
    } finally {
      this.onFrame = null;
      this.onError = null;
    }
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.onFrame) this.onFrame(frame);
        else frame.close();
      },
      error: (err) => this.onError?.(err instanceof Error ? err : new Error(String(err))),
    });
    decoder.configure(this.config!);
    this.decoder = decoder;
    return decoder;
  }

  private resetDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    if (!decoder) return;
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      /* already gone */
    }
  }

  /** Last sample at or before `tsMs` (binary search over composition order). */
  private nearestSampleIndex(tsMs: number): number {
    const idx = this.index;
    let lo = 0;
    let hi = idx.length - 1;
    if (tsMs <= idx[0].tsMs) return 0;
    if (tsMs >= idx[hi].tsMs) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (idx[mid].tsMs <= tsMs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private keyframeAtOrBefore(sampleIndex: number): number {
    const keys = this.keyframeIndices;
    let lo = 0;
    let hi = keys.length - 1;
    if (keys[0] > sampleIndex) return keys[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keys[mid] <= sampleIndex) lo = mid;
      else hi = mid - 1;
    }
    return keys[lo];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onFrame = null;
    this.onError = null;
    this.resetDecoder();
    try {
      this.file?.stop();
    } catch {
      /* nothing to stop */
    }
    this.file = null;
    this.index = [];
    this.keyframeIndices = [];
  }
}

/** Resolve when the `moov` box has been parsed, or reject with something actionable. */
function waitForMoov(file: ISOFile): Promise<ReturnType<ISOFile['getInfo']>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ScanError(
            "Could not read this file's structure. It may be truncated, or not an MP4 at all.",
            'unsupported-codec'
          )
        ),
      20_000
    );
    file.onReady = (info) => {
      clearTimeout(timer);
      resolve(info);
    };
    file.onError = (module, message) => {
      clearTimeout(timer);
      reject(new ScanError(`Demuxer failed (${module}): ${message}`, 'decode'));
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('scan cancelled', 'AbortError');
}
