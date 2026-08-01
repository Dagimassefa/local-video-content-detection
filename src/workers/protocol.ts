import type { FitMode, ScanConfig } from '../core/config';
import type { SampledFrame, ScanErrorKind, ScanEvent, VideoMeta } from '../core/types';

/**
 * Explicit success/failure union for calls that cross a `MessagePort`.
 *
 * Deliberately not exceptions. Comlink marshals a thrown Error by copying `name`, `message` and
 * `stack` — and *only* those — so a `ScanError` crossing the boundary arrives as a plain Error with
 * its `kind` stripped. That is not a hypothetical: the `<video>` source lives on the main thread
 * while the pipeline lives in a worker, so `probe()` always crosses, and a CORS-blocked URL — the
 * error most in need of a specific explanation, since it is unfixable and the user needs telling
 * why — was reaching the UI as "Scan failed / unknown".
 *
 * Returning the failure as a value makes the error channel part of the contract instead of a
 * property of Comlink's internals. Caught by `npm run verify`.
 */
export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ScanErrorKind; message: string };


export interface RemoteFrameSource {
  probe(): Promise<RemoteResult<VideoMeta>>;

  frameAt(tsMs: number): Promise<SampledFrame | null>;
  close(): void;
}

export interface DecodeWorkerApi {
  open(blob: Blob, options: { fit: FitMode; size: number }, port: MessagePort): Promise<void>;
  release(): void;
  close(): void;
}

export function toRemoteFailure(err: unknown): { ok: false; kind: ScanErrorKind; message: string } {
  const kind =
    err && typeof err === 'object' && 'kind' in err
      ? ((err as { kind: ScanErrorKind }).kind ?? 'unknown')
      : 'unknown';
  return {
    ok: false,
    kind,
    message: err instanceof Error ? err.message : String(err),
  };
}

export interface ScanWorkerApi {

  scan(
    sourcePort: MessagePort,
    config: ScanConfig,
    onEvent: (event: ScanEvent) => void
  ): Promise<void>;
  cancel(): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}
