import {
  applySaveData,
  budgetForTier,
  type ScanBudget,
} from './config';
import type { BackendId, DeviceTier } from './types';

/**
 * Feature detection and device tiering.
 *
 * "Device variability" is called out explicitly in the brief, and it is the hardest part of
 * shipping on-device inference to the web: the same code runs on an M-series laptop and on a
 * four-year-old Android phone with a software GL implementation. The strategy here is
 * progressive enhancement with an honest floor - detect what is genuinely available, pick the
 * fastest working path, and shrink the amount of work to match the hardware rather than
 * running the same scan badly everywhere.
 *
 * Everything is probed through an injected environment object so the tiering logic can be
 * tested against synthetic devices instead of only the machine running the tests.
 */

export interface Capabilities {
  webgpu: boolean;
  webgl2: boolean;
  wasm: boolean;
  /** WebCodecs `VideoDecoder`: the hardware-accelerated decode path. */
  webcodecs: boolean;
  offscreenCanvas: boolean;
  /** `createImageBitmap` resize options - our cheap GPU downscale. */
  imageBitmapResize: boolean;
  /** `requestVideoFrameCallback`, used by the fallback source and by segment-accurate blur. */
  videoFrameCallback: boolean;
  hardwareConcurrency: number;
  /** `navigator.deviceMemory` in GiB. Chromium-only, and coarsely bucketed by the browser. */
  deviceMemoryGb: number | null;
  saveData: boolean;
  reducedMotion: boolean;
  tier: DeviceTier;
  /** Preferred inference backend given what is actually available. */
  preferredBackend: BackendId;
  userAgent: string;
  notes: string[];
}

/** The slice of the platform we probe. Injectable purely so it can be faked in tests. */
export interface DetectionEnv {
  navigator?: {
    hardwareConcurrency?: number;
    userAgent?: string;
    gpu?: unknown;
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  /** Present in workers and on the main thread; absent in Node. */
  OffscreenCanvas?: unknown;
  VideoDecoder?: unknown;
  WebAssembly?: unknown;
  createImageBitmap?: unknown;
  HTMLVideoElement?: { prototype?: object };
  matchMedia?: (q: string) => { matches: boolean };
  /** Async adapter probe, separated so tests need not fake the whole WebGPU surface. */
  requestGpuAdapter?: () => Promise<boolean>;
  /** WebGL2 probe, likewise. */
  probeWebGL2?: () => boolean;
}

function defaultEnv(): DetectionEnv {
  const g = globalThis as Record<string, unknown> & {
    navigator?: DetectionEnv['navigator'];
    matchMedia?: DetectionEnv['matchMedia'];
  };
  return {
    navigator: g.navigator,
    OffscreenCanvas: g.OffscreenCanvas,
    VideoDecoder: g.VideoDecoder,
    WebAssembly: g.WebAssembly,
    createImageBitmap: g.createImageBitmap,
    HTMLVideoElement: g.HTMLVideoElement as { prototype?: object } | undefined,
    matchMedia: g.matchMedia ? g.matchMedia.bind(g) : undefined,
    requestGpuAdapter: async () => {
      const gpu = (g.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
      if (!gpu) return false;
      try {
        // Adapter presence is the only reliable signal. `navigator.gpu` exists on platforms
        // where adapter acquisition then fails (blocklisted drivers, headless, some VMs), and
        // trusting the namespace alone means selecting a backend that cannot initialise.
        return (await gpu.requestAdapter()) != null;
      } catch {
        return false;
      }
    },
    probeWebGL2: () => {
      try {
        const OC = g.OffscreenCanvas as
          | (new (w: number, h: number) => { getContext(t: string): unknown })
          | undefined;
        if (OC) return new OC(1, 1).getContext('webgl2') != null;
        const doc = (g as { document?: Document }).document;
        if (!doc) return false;
        return doc.createElement('canvas').getContext('webgl2') != null;
      } catch {
        return false;
      }
    },
  };
}

/** Run a probe, treating any failure as "the feature is not available". */
async function safeAsync<T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function safeSync<T>(fn: (() => T) | undefined | false, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export async function detectCapabilities(env: DetectionEnv = defaultEnv()): Promise<Capabilities> {
  const nav = env.navigator ?? {};
  const notes: string[] = [];

  // Both probes are wrapped rather than trusted. Graphics initialisation is the single most
  // failure-prone thing we touch - drivers throw, contexts fail to allocate, headless and
  // virtualised environments raise from inside the platform code - and capability detection
  // crashing would take the whole app down before it ever renders. An unusable backend must
  // read as "false", never as an exception.
  const webgpu = await safeAsync(env.requestGpuAdapter, false);
  if (!webgpu && nav.gpu) {
    notes.push('navigator.gpu exists but no adapter could be acquired; WebGPU is unusable here.');
  }

  const webgl2 = safeSync(env.probeWebGL2, false);
  const wasm = typeof env.WebAssembly !== 'undefined';
  const webcodecs = typeof env.VideoDecoder !== 'undefined';
  const offscreenCanvas = typeof env.OffscreenCanvas !== 'undefined';
  const imageBitmapResize = typeof env.createImageBitmap !== 'undefined';
  const videoFrameCallback =
    env.HTMLVideoElement?.prototype != null &&
    'requestVideoFrameCallback' in env.HTMLVideoElement.prototype;

  const hardwareConcurrency = Math.max(1, nav.hardwareConcurrency ?? 2);
  const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const saveData = nav.connection?.saveData === true;
  const reducedMotion =
    safeSync(
      env.matchMedia && (() => env.matchMedia!('(prefers-reduced-motion: reduce)').matches),
      false
    ) === true;

  if (!webcodecs) {
    notes.push(
      'WebCodecs unavailable: falling back to seek-based frame extraction, which is slower per sample.'
    );
  }
  if (!webgpu && !webgl2) {
    notes.push('No GPU backend available: inference will run on WASM/CPU and will be markedly slower.');
  }

  const preferredBackend: BackendId = webgpu ? 'webgpu' : webgl2 ? 'webgl' : wasm ? 'wasm' : 'cpu';
  const tier = classifyTier({ webgpu, webgl2, hardwareConcurrency, deviceMemoryGb });

  return {
    webgpu,
    webgl2,
    wasm,
    webcodecs,
    offscreenCanvas,
    imageBitmapResize,
    videoFrameCallback,
    hardwareConcurrency,
    deviceMemoryGb,
    saveData,
    reducedMotion,
    tier,
    preferredBackend,
    userAgent: nav.userAgent ?? 'unknown',
    notes,
  };
}

/**
 * Bucket the device into three tiers.
 *
 * Intentionally crude. There is no reliable way to identify a phone's GPU from the web
 * platform, and every attempt to do so via user-agent parsing rots within months. Core count
 * and the presence of a real GPU backend are weak signals, but they are stable, honest ones,
 * and the *governor* in the pipeline corrects the initial guess from measured latency within
 * the first few frames. Tiering only needs to pick a sensible starting budget, not be right.
 */
export function classifyTier(input: {
  webgpu: boolean;
  webgl2: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
}): DeviceTier {
  const { webgpu, webgl2, hardwareConcurrency, deviceMemoryGb } = input;

  if (!webgpu && !webgl2) return 'low';
  if (deviceMemoryGb !== null && deviceMemoryGb <= 2) return 'low';
  if (hardwareConcurrency <= 2) return 'low';

  if (webgpu && hardwareConcurrency >= 8 && (deviceMemoryGb === null || deviceMemoryGb >= 8)) {
    return 'high';
  }
  return 'medium';
}

/** Starting budget for a device, including the user's data/battery-saving preference. */
export function budgetFor(caps: Capabilities): ScanBudget {
  const base = budgetForTier(caps.tier);
  return caps.saveData ? applySaveData(base) : base;
}

/** One-line summary for the benchmark table in `docs/04-benchmarks.md`. */
export function describeCapabilities(caps: Capabilities): string {
  const mem = caps.deviceMemoryGb === null ? 'mem n/a' : `${caps.deviceMemoryGb} GB`;
  const decode = caps.webcodecs ? 'WebCodecs' : 'video-element';
  return `${caps.tier} tier - ${caps.preferredBackend} - ${caps.hardwareConcurrency} cores - ${mem} - ${decode}`;
}
