import * as Comlink from 'comlink';
import { WebCodecsFrameSource } from '../core/frames/webcodecs';
import { toRemoteFailure, type DecodeWorkerApi, type RemoteFrameSource } from './protocol';
import type { FitMode } from '../core/config';

/**
 * Hardware decode, isolated in its own worker.
 *
 * Two workers rather than one, because decode and inference then genuinely PIPELINE: frame
 * N+1 is being demuxed and decoded while frame N is still in the model. With a single worker
 * they would serialise and the wall-clock cost per sample would be decode + inference instead
 * of max(decode, inference).
 *
 * The frames also never touch the main thread. `scan.worker` talks to this worker over a
 * direct `MessageChannel`, so an `ImageBitmap` goes worker -> worker as a transferable and the
 * UI thread does literally zero per-frame work. That is what the long-task counter in the perf
 * panel is measuring, and why it stays at zero during a scan.
 */

let source: WebCodecsFrameSource | null = null;

const api: DecodeWorkerApi = {
  async open(blob: Blob, options: { fit: FitMode; size: number }, port: MessagePort) {
    source?.close();
    const created = new WebCodecsFrameSource(blob, options);
    source = created;

    const remote: RemoteFrameSource = {
      async probe() {
        try {
          return { ok: true, value: await created.probe() };
        } catch (err) {
          return toRemoteFailure(err);
        }
      },
      async frameAt(tsMs: number) {
        const frame = await created.frameAt(tsMs);
        if (!frame) return null;
        return Comlink.transfer(frame, [frame.bitmap]);
      },
      close: () => created.close(),
    };

    Comlink.expose(remote, port);
  },

  release() {
    source?.close();
    source = null;
  },

  close() {
    source?.close();
    source = null;
  },
};

Comlink.expose(api);
