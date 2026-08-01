import type { HistogramSnapshot, PerfSnapshot } from './types';

/**
 * Lightweight timing instrumentation.
 *
 * One of the challenge deliverables is performance measurements, and the honest way to
 * produce those is to have the application measure itself rather than to time it by hand and
 * transcribe the numbers. Everything reported in `docs/04-benchmarks.md` comes out of here.
 *
 * Deliberately p50/p95 rather than means. A mean per-frame latency hides exactly the thing
 * that matters on mobile - the occasional 300 ms frame caused by a shader recompile or a
 * thermal step - and a p95 makes it visible.
 */

/**
 * Fixed-capacity reservoir of samples.
 *
 * Bounded because a long scan can produce thousands of measurements and an unbounded array
 * would make the profiler itself a memory problem. Keeps the most recent `capacity` samples,
 * which is what you want when watching a device throttle over time.
 */
export class Histogram {
  private samples: number[] = [];
  private droppedCount = 0;
  private observedMax = 0;

  constructor(private readonly capacity = 512) {}

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.observedMax = Math.max(this.observedMax, ms);
    this.samples.push(ms);
    if (this.samples.length > this.capacity) {
      this.samples.shift();
      this.droppedCount++;
    }
  }

  private quantile(q: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    // Nearest-rank; with a few hundred samples the interpolation difference is noise.
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  }

  snapshot(): HistogramSnapshot {
    const count = this.samples.length + this.droppedCount;
    const mean =
      this.samples.length === 0
        ? 0
        : this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    return {
      count,
      p50: round2(this.quantile(0.5)),
      p95: round2(this.quantile(0.95)),
      // Retained across eviction: the worst frame in a scan is the interesting one, and it
      // must not be able to fall out of the window.
      max: round2(this.observedMax),
      mean: round2(mean),
    };
  }

  reset(): void {
    this.samples = [];
    this.droppedCount = 0;
    this.observedMax = 0;
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Injectable clock so timing logic is testable without real elapsed time. */
export type Clock = () => number;

const defaultClock: Clock = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class MetricsRegistry {
  private readonly histograms = new Map<string, Histogram>();
  private readonly startedAt: number;
  private counters = new Map<string, number>();

  constructor(private readonly clock: Clock = defaultClock) {
    this.startedAt = clock();
  }

  /** Start a timer; call the returned function to record the elapsed duration. */
  start(name: string): () => number {
    const t0 = this.clock();
    return () => {
      const dt = this.clock() - t0;
      this.histogram(name).add(dt);
      return dt;
    };
  }

  /** Time an async operation, recording it even if it throws. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stop = this.start(name);
    try {
      return await fn();
    } finally {
      stop();
    }
  }

  record(name: string, ms: number): void {
    this.histogram(name).add(ms);
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  private histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    return h;
  }

  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  snapshot(extra?: { tensors?: { numTensors: number; numBytes: number } }): PerfSnapshot {
    const timers: Record<string, HistogramSnapshot> = {};
    for (const [name, h] of this.histograms) timers[name] = h.snapshot();

    const inferred = timers[TIMER.inference]?.count ?? 0;
    const seconds = this.elapsedMs / 1000;

    return {
      timers,
      tensors: extra?.tensors,
      throughput: seconds > 0 ? round2(inferred / seconds) : 0,
      counters: Object.fromEntries(this.counters),
    };
  }

  reset(): void {
    this.histograms.clear();
    this.counters = new Map();
  }
}

/** Canonical timer names, so the worker and the UI cannot drift apart on spelling. */
export const TIMER = {
  demux: 'demux',
  decode: 'decode',
  resize: 'resize',
  hash: 'hash',
  inference: 'inference',
  /** Everything for one sample: request -> decode -> resize -> hash -> classify -> aggregate. */
  frameTotal: 'frame.total',
  modelLoad: 'model.load',
  warmup: 'model.warmup',
} as const;
