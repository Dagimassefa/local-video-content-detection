import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  classifyTier,
  describeCapabilities,
  detectCapabilities,
  type Capabilities,
  type DetectionEnv,
} from './capabilities';
import { BASE_BUDGET } from './config';

/** A believable high-end desktop, which individual tests then degrade. */
function env(overrides: Partial<DetectionEnv> = {}): DetectionEnv {
  return {
    navigator: {
      hardwareConcurrency: 12,
      userAgent: 'test-agent',
      gpu: {},
      deviceMemory: 8,
      connection: { saveData: false },
    },
    OffscreenCanvas: class {},
    VideoDecoder: class {},
    WebAssembly: {},
    createImageBitmap: () => {},
    HTMLVideoElement: { prototype: { requestVideoFrameCallback() {} } },
    matchMedia: () => ({ matches: false }),
    requestGpuAdapter: async () => true,
    probeWebGL2: () => true,
    ...overrides,
  };
}

describe('detectCapabilities', () => {
  it('reports a fully-capable device', async () => {
    const caps = await detectCapabilities(env());
    expect(caps.webgpu).toBe(true);
    expect(caps.webcodecs).toBe(true);
    expect(caps.videoFrameCallback).toBe(true);
    expect(caps.preferredBackend).toBe('webgpu');
    expect(caps.tier).toBe('high');
    expect(caps.notes).toEqual([]);
  });

  it('does not trust navigator.gpu without an actual adapter', async () => {
    // navigator.gpu exists on plenty of machines where adapter acquisition then fails -
    // blocklisted drivers, headless, VMs. Selecting webgpu there means picking a backend that
    // cannot initialise, so the namespace alone is not evidence.
    const caps = await detectCapabilities(env({ requestGpuAdapter: async () => false }));
    expect(caps.webgpu).toBe(false);
    expect(caps.preferredBackend).toBe('webgl');
    expect(caps.notes.join(' ')).toMatch(/no adapter/i);
  });

  it('survives an adapter probe that throws', async () => {
    const caps = await detectCapabilities(
      env({
        requestGpuAdapter: async () => {
          throw new Error('driver exploded');
        },
      })
    );
    expect(caps.webgpu).toBe(false);
  }, 10_000);

  it('falls back through the backend chain as capabilities disappear', async () => {
    expect((await detectCapabilities(env())).preferredBackend).toBe('webgpu');
    expect(
      (await detectCapabilities(env({ requestGpuAdapter: async () => false }))).preferredBackend
    ).toBe('webgl');
    expect(
      (
        await detectCapabilities(
          env({ requestGpuAdapter: async () => false, probeWebGL2: () => false })
        )
      ).preferredBackend
    ).toBe('wasm');
    expect(
      (
        await detectCapabilities(
          env({
            requestGpuAdapter: async () => false,
            probeWebGL2: () => false,
            WebAssembly: undefined,
          })
        )
      ).preferredBackend
    ).toBe('cpu');
  });

  it('explains the consequence when WebCodecs is missing', async () => {
    const caps = await detectCapabilities(env({ VideoDecoder: undefined }));
    expect(caps.webcodecs).toBe(false);
    expect(caps.notes.join(' ')).toMatch(/seek-based/i);
  });

  it('warns when there is no GPU backend at all', async () => {
    const caps = await detectCapabilities(
      env({ requestGpuAdapter: async () => false, probeWebGL2: () => false })
    );
    expect(caps.notes.join(' ')).toMatch(/markedly slower/i);
  });

  it('detects requestVideoFrameCallback being absent', async () => {
    const caps = await detectCapabilities(env({ HTMLVideoElement: { prototype: {} } }));
    expect(caps.videoFrameCallback).toBe(false);
  });

  it('picks up saveData and reduced-motion preferences', async () => {
    const caps = await detectCapabilities(
      env({
        navigator: { hardwareConcurrency: 8, connection: { saveData: true }, gpu: {} },
        matchMedia: (q) => ({ matches: q.includes('reduced-motion') }),
      })
    );
    expect(caps.saveData).toBe(true);
    expect(caps.reducedMotion).toBe(true);
  });

  it('degrades gracefully in a bare environment instead of throwing', async () => {
    // Server-side rendering, an old browser, a locked-down webview: detection must return a
    // usable answer rather than crash the app before it renders.
    const caps = await detectCapabilities({});
    expect(caps.preferredBackend).toBe('cpu');
    expect(caps.tier).toBe('low');
    expect(caps.hardwareConcurrency).toBeGreaterThanOrEqual(1);
    expect(caps.deviceMemoryGb).toBeNull();
  });

  it('reports missing deviceMemory as unknown rather than guessing', async () => {
    const caps = await detectCapabilities(
      env({ navigator: { hardwareConcurrency: 8, gpu: {} } })
    );
    expect(caps.deviceMemoryGb).toBeNull();
  });
});

describe('classifyTier', () => {
  const t = (o: Partial<Parameters<typeof classifyTier>[0]>) =>
    classifyTier({ webgpu: true, webgl2: true, hardwareConcurrency: 8, deviceMemoryGb: 8, ...o });

  it('is low with no GPU backend whatsoever', () => {
    expect(t({ webgpu: false, webgl2: false })).toBe('low');
  });

  it('is low on a memory-constrained device even with a GPU', () => {
    expect(t({ deviceMemoryGb: 2 })).toBe('low');
  });

  it('is low on very few cores', () => {
    expect(t({ hardwareConcurrency: 2 })).toBe('low');
  });

  it('is high only with WebGPU plus real cores and memory', () => {
    expect(t({})).toBe('high');
    expect(t({ webgpu: false })).toBe('medium');
    expect(t({ hardwareConcurrency: 4 })).toBe('medium');
    expect(t({ deviceMemoryGb: 4 })).toBe('medium');
  });

  it('gives unknown memory the benefit of the doubt', () => {
    // deviceMemory is Chromium-only. Treating "unknown" as "bad" would permanently cap Safari
    // and Firefox users at a reduced budget for no reason.
    expect(t({ deviceMemoryGb: null })).toBe('high');
  });
});

describe('budgetFor', () => {
  const caps = (over: Partial<Capabilities>): Capabilities =>
    ({
      webgpu: true,
      webgl2: true,
      wasm: true,
      webcodecs: true,
      offscreenCanvas: true,
      imageBitmapResize: true,
      videoFrameCallback: true,
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      saveData: false,
      reducedMotion: false,
      tier: 'medium',
      preferredBackend: 'webgpu',
      userAgent: 'test',
      notes: [],
      ...over,
    }) as Capabilities;

  it('scales the frame budget with the tier', () => {
    const high = budgetFor(caps({ tier: 'high' })).maxFrames;
    const medium = budgetFor(caps({ tier: 'medium' })).maxFrames;
    const low = budgetFor(caps({ tier: 'low' })).maxFrames;
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });

  it('gives a low-tier device a more forgiving latency target', () => {
    // The governor compares measured latency against this. A weak device should not be
    // permanently in "degrade" mode simply for being weak.
    expect(budgetFor(caps({ tier: 'low' })).targetInferenceMs).toBeGreaterThan(
      BASE_BUDGET.targetInferenceMs
    );
  });

  it('cuts the budget further when the user has asked to save data', () => {
    const normal = budgetFor(caps({ tier: 'medium' }));
    const saving = budgetFor(caps({ tier: 'medium', saveData: true }));
    expect(saving.maxFrames).toBeLessThan(normal.maxFrames);
    expect(saving.surveyFrames).toBeLessThan(normal.surveyFrames);
    expect(saving.maxWallClockMs).toBeLessThan(normal.maxWallClockMs);
  });

  it('never reduces a budget to nothing', () => {
    const saving = budgetFor(caps({ tier: 'low', saveData: true }));
    expect(saving.surveyFrames).toBeGreaterThanOrEqual(6);
    expect(saving.maxFrames).toBeGreaterThanOrEqual(16);
  });
});

describe('describeCapabilities', () => {
  it('summarises a device in one line for the benchmark table', () => {
    const line = describeCapabilities({
      tier: 'high',
      preferredBackend: 'webgpu',
      hardwareConcurrency: 12,
      deviceMemoryGb: 8,
      webcodecs: true,
    } as Capabilities);
    expect(line).toBe('high tier - webgpu - 12 cores - 8 GB - WebCodecs');
  });

  it('says so when memory is unknown', () => {
    const line = describeCapabilities({
      tier: 'medium',
      preferredBackend: 'webgl',
      hardwareConcurrency: 4,
      deviceMemoryGb: null,
      webcodecs: false,
    } as Capabilities);
    expect(line).toContain('mem n/a');
    expect(line).toContain('video-element');
  });
});
