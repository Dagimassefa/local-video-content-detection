import { describe, expect, it } from 'vitest';
import { Histogram, MetricsRegistry, TIMER } from './metrics';

/** Deterministic clock, so timing behaviour is testable without real elapsed time. */
function fakeClock() {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Histogram', () => {
  it('is empty until something is recorded', () => {
    const snap = new Histogram().snapshot();
    expect(snap).toEqual({ count: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  });

  it('computes percentiles and mean', () => {
    const h = new Histogram();
    for (let i = 1; i <= 100; i++) h.add(i);
    const snap = h.snapshot();
    expect(snap.count).toBe(100);
    expect(snap.p50).toBe(50);
    expect(snap.p95).toBe(95);
    expect(snap.max).toBe(100);
    expect(snap.mean).toBe(50.5);
  });

  it('reports the tail, which is what a mean would hide', () => {
    // 99 fast frames and one 400 ms stall: the mean barely moves, so the mean is the wrong
    // statistic for judging whether a scan felt smooth.
    const h = new Histogram();
    for (let i = 0; i < 99; i++) h.add(10);
    h.add(400);
    const snap = h.snapshot();
    expect(snap.p50).toBe(10);
    expect(snap.max).toBe(400);
    expect(snap.mean).toBeLessThan(15);
  });

  it('retains the observed max even after samples are evicted', () => {
    // The worst frame of a scan is the interesting one; it must not be able to age out of the
    // window and silently disappear from the report.
    const h = new Histogram(4);
    h.add(999);
    for (let i = 0; i < 20; i++) h.add(5);
    expect(h.snapshot().max).toBe(999);
  });

  it('keeps counting past its retention capacity', () => {
    const h = new Histogram(4);
    for (let i = 0; i < 20; i++) h.add(5);
    expect(h.snapshot().count).toBe(20);
  });

  it('ignores nonsense measurements', () => {
    const h = new Histogram();
    h.add(Number.NaN);
    h.add(Number.POSITIVE_INFINITY);
    h.add(-1);
    expect(h.snapshot().count).toBe(0);
  });

  it('resets', () => {
    const h = new Histogram();
    h.add(50);
    h.reset();
    expect(h.snapshot().count).toBe(0);
    expect(h.snapshot().max).toBe(0);
  });
});

describe('MetricsRegistry', () => {
  it('times an operation', () => {
    const { clock, advance } = fakeClock();
    const m = new MetricsRegistry(clock);
    const stop = m.start(TIMER.inference);
    advance(42);
    expect(stop()).toBe(42);
    expect(m.snapshot().timers[TIMER.inference].p50).toBe(42);
  });

  it('records a timing even when the operation throws', () => {
    const { clock, advance } = fakeClock();
    const m = new MetricsRegistry(clock);
    const promise = m.time(TIMER.decode, async () => {
      advance(17);
      throw new Error('decode failed');
    });
    return promise.catch(() => {
      // A failure that takes 17 ms still consumed 17 ms of the user's budget.
      expect(m.snapshot().timers[TIMER.decode].count).toBe(1);
      expect(m.snapshot().timers[TIMER.decode].p50).toBe(17);
    });
  });

  it('tracks independent timers separately', () => {
    const { clock, advance } = fakeClock();
    const m = new MetricsRegistry(clock);
    const a = m.start(TIMER.decode);
    advance(10);
    a();
    const b = m.start(TIMER.inference);
    advance(30);
    b();
    const snap = m.snapshot();
    expect(snap.timers[TIMER.decode].p50).toBe(10);
    expect(snap.timers[TIMER.inference].p50).toBe(30);
  });

  it('counts events', () => {
    const m = new MetricsRegistry(fakeClock().clock);
    m.increment('deduped');
    m.increment('deduped', 4);
    expect(m.count('deduped')).toBe(5);
    expect(m.count('never-touched')).toBe(0);
  });

  it('exposes counters in the snapshot', () => {
    // The benchmark harness reads `governor.throttled` from here to prove the latency governor
    // actually fired under CPU throttling, rather than asserting that it would.
    const m = new MetricsRegistry(fakeClock().clock);
    m.increment('governor.throttled', 3);
    m.increment('deduped');
    expect(m.snapshot().counters).toEqual({ 'governor.throttled': 3, deduped: 1 });
  });

  it('reports an empty counter map before anything happens', () => {
    expect(new MetricsRegistry(fakeClock().clock).snapshot().counters).toEqual({});
  });

  it('derives throughput from inference count over elapsed time', () => {
    const { clock, advance } = fakeClock();
    const m = new MetricsRegistry(clock);
    for (let i = 0; i < 20; i++) {
      const stop = m.start(TIMER.inference);
      advance(50);
      stop();
    }
    // 20 inferences across 1000 ms of wall clock.
    expect(m.elapsedMs).toBe(1_000);
    expect(m.snapshot().throughput).toBe(20);
  });

  it('reports zero throughput before any work happens', () => {
    expect(new MetricsRegistry(fakeClock().clock).snapshot().throughput).toBe(0);
  });

  it('passes tensor accounting through for the leak canary', () => {
    const m = new MetricsRegistry(fakeClock().clock);
    const snap = m.snapshot({ tensors: { numTensors: 12, numBytes: 4096 } });
    expect(snap.tensors).toEqual({ numTensors: 12, numBytes: 4096 });
  });

  it('resets', () => {
    const { clock, advance } = fakeClock();
    const m = new MetricsRegistry(clock);
    const stop = m.start(TIMER.inference);
    advance(5);
    stop();
    m.increment('x');
    m.reset();
    expect(m.snapshot().timers).toEqual({});
    expect(m.count('x')).toBe(0);
  });
});
