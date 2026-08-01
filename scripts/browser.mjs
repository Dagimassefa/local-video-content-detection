/**
 * Shared browser launcher for the fixture generator and the E2E/benchmark harness.
 *
 * Deliberately prefers a REAL locally-installed Chrome or Edge over Playwright's bundled
 * Chromium, and runs HEADED by default. That is not laziness about headless mode - it is
 * required for the numbers to mean anything:
 *
 *  - Headless Chrome commonly falls back to SwiftShader (software rasterisation) for WebGL and
 *    has no WebGPU adapter at all. Benchmarking inference there would measure a CPU rasteriser
 *    and report it as GPU performance, which is worse than not measuring.
 *  - Hardware video decode through WebCodecs likewise needs a real GPU stack.
 *
 * So: real browser, real GPU, real numbers. `HEADLESS=1` is available for CI, where the
 * mechanical assertions still hold even though the timings should be ignored.
 */

import { chromium, devices, firefox, webkit } from 'playwright';


export const DEVICE_PRESETS = {
  'pixel-7': devices['Pixel 7'] ?? devices['Pixel 5'],
  'iphone-15': devices['iPhone 15'] ?? devices['iPhone 14'] ?? devices['iPhone 13'],
  'galaxy-s9': devices['Galaxy S9+'],
  'ipad-mini': devices['iPad Mini'],
};

export function resolveDevice(name) {
  if (!name) return null;
  const preset = DEVICE_PRESETS[name];
  if (!preset) {
    throw new Error(
      `unknown device "${name}" (have: ${Object.keys(DEVICE_PRESETS).join(', ')})`
    );
  }
  return preset;
}

const LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // Ask for WebGPU/hardware paths explicitly rather than hoping for the default.
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
];

export const ENGINES = {
  chrome: { type: chromium, options: { channel: 'chrome' }, engine: 'Chromium' },
  msedge: { type: chromium, options: { channel: 'msedge' }, engine: 'Chromium' },
  chromium: { type: chromium, options: {}, engine: 'Chromium' },
  firefox: { type: firefox, options: {}, engine: 'Gecko' },
  webkit: { type: webkit, options: {}, engine: 'WebKit' },
};

export async function launchNamed(name, { headless = process.env.HEADLESS === '1' } = {}) {
  const spec = ENGINES[name];
  if (!spec) throw new Error(`unknown engine "${name}" (have: ${Object.keys(ENGINES).join(', ')})`);
  const args = spec.type === chromium ? LAUNCH_ARGS : undefined;
  const browser = await spec.type.launch({ ...spec.options, headless, ...(args ? { args } : {}) });
  return { browser, label: name, engine: spec.engine, version: browser.version() };
}

export async function availableEngines(opts = {}) {
  const available = [];
  for (const name of Object.keys(ENGINES)) {
    try {
      const { browser, engine, version } = await launchNamed(name, opts);
      await browser.close();
      available.push({ name, engine, version });
    } catch {
        console.log(`Browser ${name} not available, skipping.`);
    }
  }
  return available;
}

export async function launchBrowser({ headless = process.env.HEADLESS === '1' } = {}) {
  const failures = [];
  for (const name of ['chrome', 'msedge', 'chromium']) {
    try {
      return await launchNamed(name, { headless });
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  throw new Error(`No usable browser found.\n${failures.join('\n')}`);
}
