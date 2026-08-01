import * as Comlink from 'comlink';
import type { ScanConfig } from '../core/config';
import {
  chooseFrameSourceKind,
  looksLikeIsoBmff,
  ScanError,
  type SourceDecision,
} from '../core/frames/FrameSource';
import { VideoElementFrameSource } from '../core/frames/videoElement';
import type { ScanEvent } from '../core/types';
import DecodeWorker from './decode.worker?worker';
import ScanWorker from './scan.worker?worker';
import {
  toRemoteFailure,
  type DecodeWorkerApi,
  type RemoteFrameSource,
  type ScanWorkerApi,
} from './protocol';

/**
 * Main-thread orchestration: decide which frame source to use, stand it up on a `MessagePort`,
 * and hand that port to the scan worker.
 *
 * Everything here is setup and teardown. Once a scan is running, this class does nothing per
 * frame - it only forwards events to the UI and relays visibility changes. That is the point.
 */

export type ScanInput =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string };

export interface StartOptions {
  input: ScanInput;
  config: ScanConfig;
  onEvent: (event: ScanEvent) => void;
  /** Reports which frame source was chosen and why, for display. */
  onSourceDecision?: (decision: SourceDecision) => void;
}

export class ScanController {
  private scanWorker: Worker | null = null;
  private scanApi: Comlink.Remote<ScanWorkerApi> | null = null;
  private decodeWorker: Worker | null = null;
  private decodeApi: Comlink.Remote<DecodeWorkerApi> | null = null;

  /** Kept so it can be closed on teardown - a `<video>` source holds a media pipeline open. */
  private localSource: VideoElementFrameSource | null = null;
  private objectUrl: string | null = null;
  private visibilityHandler: (() => void) | null = null;
  private running = false;

  /**
   * Spin up the scan worker eagerly, before the user picks a video.
   *
   * Worker startup plus the dynamic tfjs import is a few hundred milliseconds that would
   * otherwise land squarely between "user clicks scan" and "anything happens". Doing it while
   * they are still choosing a file makes it free.
   */
  warmUp(): void {
    this.ensureScanWorker();
  }

  private ensureScanWorker(): Comlink.Remote<ScanWorkerApi> {
    if (this.scanApi) return this.scanApi;
    this.scanWorker = new ScanWorker();
    this.scanApi = Comlink.wrap<ScanWorkerApi>(this.scanWorker);
    return this.scanApi;
  }

  async start({ input, config, onEvent, onSourceDecision }: StartOptions): Promise<void> {
    await this.stop();
    this.running = true;

    const scanApi = this.ensureScanWorker();
    const channel = new MessageChannel();

    try {
      const decision = await this.buildSource(input, config, channel.port1);
      onSourceDecision?.(decision);
    } catch (err) {
      this.running = false;
      const scanError =
        err instanceof ScanError
          ? err
          : new ScanError(err instanceof Error ? err.message : String(err), 'unknown');
      onEvent({ type: 'error', message: scanError.message, kind: scanError.kind });
      return;
    }

    // Pause on a hidden tab. On mobile this is the difference between a scan that drains the
    // battery in a background tab and one that simply stops until the user comes back.
    if (config.pauseWhenHidden) {
      this.visibilityHandler = () => {
        void this.scanApi?.setPaused(document.hidden);
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      void scanApi.setPaused(document.hidden);
    }

    try {
      await scanApi.scan(
        Comlink.transfer(channel.port2, [channel.port2]),
        config,
        Comlink.proxy(onEvent)
      );
    } finally {
      this.running = false;
      this.detachVisibility();
    }
  }

  /**
   * Stand up the appropriate frame source and expose it on `port`.
   *
   * Both branches end the same way - a {@link RemoteFrameSource} on a port - which is what lets
   * the worker-side pipeline be completely indifferent to which one it got.
   */
  private async buildSource(
    input: ScanInput,
    config: ScanConfig,
    port: MessagePort
  ): Promise<SourceDecision> {
    const isLocalFile = input.kind === 'file';
    const byteLength = isLocalFile ? input.file.size : null;

    let containerLikelyIsoBmff = false;
    if (isLocalFile) {
      // Sniff the actual bytes. `File.type` comes from the filename extension on most
      // platforms and is wrong often enough that trusting it means picking the wrong decoder.
      const head = await input.file.slice(0, 64).arrayBuffer();
      containerLikelyIsoBmff = looksLikeIsoBmff(head);
    }

    const decision = chooseFrameSourceKind({
      isLocalFile,
      byteLength,
      webcodecsAvailable: typeof VideoDecoder !== 'undefined',
      containerLikelyIsoBmff,
    });

    const options = { fit: config.fitMode, size: 224 };

    if (decision.kind === 'webcodecs' && input.kind === 'file') {
      // Reused across scans, not recreated.
      //
      // Constructing a Worker fetches and evaluates its script, which is both a real startup cost
      // per scan and — as `npm run verify` demonstrated — a NETWORK REQUEST. That broke the
      // "works offline" property outright: a second scan with the network blocked hung waiting for
      // a worker script it could not fetch. Keeping the worker alive means a repeat scan touches
      // the network zero times.
      if (!this.decodeApi) {
        this.decodeWorker = new DecodeWorker();
        this.decodeApi = Comlink.wrap<DecodeWorkerApi>(this.decodeWorker);
      }
      await this.decodeApi.open(input.file, options, Comlink.transfer(port, [port]));
      return decision;
    }

    // `<video>` path. It must live on the main thread - a video element cannot exist in a
    // worker - so this is the one and only place the UI thread does per-frame work: a single
    // ImageBitmap transfer per sample.
    const src =
      input.kind === 'file' ? (this.objectUrl = URL.createObjectURL(input.file)) : input.url;
    const sameOrigin = input.kind === 'file' || isSameOrigin(src);

    const source = new VideoElementFrameSource(src, options, sameOrigin);
    this.localSource = source;

    const remote: RemoteFrameSource = {
      async probe() {
        try {
          return { ok: true as const, value: await source.probe() };
        } catch (err) {
          // Returned, never thrown. This is the path a CORS failure takes, and Comlink would strip
          // the error's `kind` on the way across. See `RemoteResult` in protocol.ts.
          return toRemoteFailure(err);
        }
      },
      async frameAt(tsMs: number) {
        const frame = await source.frameAt(tsMs);
        if (!frame) return null;
        return Comlink.transfer(frame, [frame.bitmap]);
      },
      close: () => source.close(),
    };
    Comlink.expose(remote, port);

    return decision;
  }

  cancel(): void {
    void this.scanApi?.cancel();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Tear down the current scan's resources, keeping the warm scan worker alive. */
  async stop(): Promise<void> {
    this.cancel();
    this.detachVisibility();

    this.localSource?.close();
    this.localSource = null;

    // Object URLs pin the entire file in memory until revoked. Forgetting this on a few
    // multi-hundred-megabyte uploads is a straightforward way to exhaust a tab.
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    // Release the decoder and its file handle, but keep the worker itself warm for the next scan.
    if (this.decodeApi) {
      try {
        await this.decodeApi.release();
      } catch {
        /* worker may already be gone */
      }
    }
    this.running = false;
  }

  /** Full teardown, including both workers and the model. Call on unmount. */
  async destroy(): Promise<void> {
    await this.stop();
    if (this.decodeApi) {
      try {
        await this.decodeApi.close();
      } catch {
        /* already gone */
      }
    }
    this.decodeWorker?.terminate();
    this.decodeWorker = null;
    this.decodeApi = null;
    try {
      await this.scanApi?.dispose();
    } catch {
      /* already gone */
    }
    this.scanWorker?.terminate();
    this.scanWorker = null;
    this.scanApi = null;
  }

  private detachVisibility(): void {
    if (!this.visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
