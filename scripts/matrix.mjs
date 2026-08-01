#!/usr/bin/env node
/**
 * Cross-engine and simulated-device benchmark matrix.
 *
 * `bench.mjs` answers "how fast is it here". This answers the two questions that one cannot:
 *
 *   1. **Does it work on engines other than Chromium?** Gecko and WebKit take completely different
 *      code paths - no WebGPU on these builds, different seek behaviour, different codec support -
 *      and WebKit is the engine Safari ships, including on iOS. It is the closest proxy available
 *      for the engine half of the mobile target.
 *
 *   2. **What happens on a slow device?** Real phones were not available, so CPU throttling via CDP
 *      stands in. Read the caveat below before trusting the numbers.
 *
 * ## What CPU throttling does and does not simulate
 *
 * `Emulation.setCPUThrottlingRate` slows the main thread and worker JS by an integer factor. It is a
 * genuine, standard proxy for a slower CPU, and it is honest about being one:
 *
 *   - It DOES slow JS execution, WASM, and the orchestration loop - so the WASM inference path and
 *     the whole control path really are measured under load.
 *   - It DOES NOT slow the GPU. WebGPU/WebGL inference and hardware video decode run at full desktop
 *     speed, so throttled GPU-backend timings understate mobile cost, probably substantially.
 *   - It DOES NOT reproduce thermal behaviour, memory pressure, or mobile driver quirks.
 *
 * The one thing it establishes beyond doubt is that the **adaptive machinery actually engages**: the
 * latency governor firing, the budget shrinking, and the verdict still arriving are all observable
 * here, and were previously only unit-tested. That is the point of running it.
 *
 * Usage:
 *   node scripts/matrix.mjs                       # every available engine, 1x + 4x + 6x CPU
 *   node scripts/matrix.mjs --engines=chrome,webkit
 *   node scripts/matrix.mjs --throttle=1,6 --fixture=long-3min.mp4
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableEngines, DEVICE_PRESETS, launchNamed, resolveDevice } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = 4192;
const ORIGIN = `http://localhost:${PORT}`;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const FIXTURE = arg('fixture', 'bars-12s.mp4');

const BACKEND = arg('backend', 'auto');
const THROTTLES = arg('throttle', '1,4,6')
  .split(',')
  .map(Number)
  .filter((n) => n >= 1);
const DEVICES = arg('devices', 'pixel-7,iphone-15')
  .split(',')
  .map((d) => d.trim())
  .filter((d) => d.length > 0 && d in DEVICE_PRESETS);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/__fixture') {
        const media = await readFile(join(ROOT, 'fixtures', FIXTURE));
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
        res.end(media);
        return;
      }
      let path = join(DIST, decodeURIComponent(url.pathname));
      const info = await stat(path).catch(() => null);
      if (!info || info.isDirectory()) path = join(DIST, 'index.html');
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, r));
  return { close: () => new Promise((r) => server.close(r)) };
}

async function waitForScan(page, timeout) {
  const handle = await page.waitForFunction(
    () => {
      const s = window.__vcd?.getState?.();
      if (s?.error) return { error: s.error };
      if (s?.result?.finalized) {
        return {
          verdict: s.result.verdict,
          stats: s.result.stats,
          perf: s.perf,
          backend: s.backend,
          caps: s.capabilities,
        };
      }
      return false;
    },
    null,
    { timeout, polling: 200 }
  );
  return handle.jsonValue();
}


async function runOne({ engine, throttle, mobile, device }) {
  const launched = await launchNamed(engine);
  const { browser, version, engine: engineFamily } = launched;

  const preset = resolveDevice(device);
  const context = await browser.newContext(
    preset
      ? { ...preset, isMobile: engineFamily === 'Chromium' ? preset.isMobile : undefined }
      : mobile
        ? {
            viewport: { width: 393, height: 851 },
            deviceScaleFactor: 2.75,
            isMobile: engineFamily === 'Chromium',
            hasTouch: true,
          }
        : { viewport: { width: 1440, height: 1000 } }
  );

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  let throttleApplied = false;
  if (throttle > 1 && engineFamily === 'Chromium') {
    // rather than silently reporting an unthrottled number under a throttled heading.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    throttleApplied = true;
  }

  await page.goto(ORIGIN, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__vcd?.getState), null, { timeout: 60_000 });

  const env = await page.evaluate(async () => {
    let adapter = false;
    try {
      adapter = navigator.gpu ? (await navigator.gpu.requestAdapter()) != null : false;
    } catch {
      adapter = false;
    }
    const probe = document.createElement('video');
    return {
      cores: navigator.hardwareConcurrency,
      webgpu: adapter,
      webcodecs: typeof VideoDecoder !== 'undefined',
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      canPlayMp4: probe.canPlayType('video/mp4; codecs="avc1.42E01E"') || 'no',
      canPlayWebm: probe.canPlayType('video/webm; codecs="vp9"') || 'no',
      ua: navigator.userAgent,
    };
  });

  const codecless = await page.evaluate(async (fixtureUrl) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const outcome = await new Promise((res) => {
      const t = setTimeout(() => res('timeout'), 8000);
      v.addEventListener('loadedmetadata', () => { clearTimeout(t); res('ok'); }, { once: true });
      v.addEventListener('error', () => { clearTimeout(t); res(`err${v.error?.code ?? '?'}`); }, { once: true });
      v.src = fixtureUrl;
    });
    v.removeAttribute('src');
    return outcome !== 'ok';
  }, `${ORIGIN}/__fixture`);

  if (BACKEND !== 'auto') {
    await page.evaluate((b) => window.__vcd.setBackendPref(b), BACKEND);
  }

  await page.setInputFiles('input[type=file]', join(ROOT, 'fixtures', FIXTURE));
  const clickNote = await clickPrimary(page);

  // patience scales with both the throttle and the engine rather than assuming Chromium speeds.
  const timeout = 120_000 * Math.max(1, throttle) * (engineFamily === 'Chromium' ? 1 : 2);
  let out;
  try {
    out = await waitForScan(page, timeout);
  } catch (err) {
    out = { error: { kind: 'timeout', message: String(err).split('\n')[0] } };
  }

  if (mobile && !out.error) {
    await page.screenshot({
      path: join(ROOT, 'fixtures', `mobile-${device ?? engine}.png`),
      fullPage: false,
    });
  }

  await browser.close();
  return {
    engine,
    engineFamily,
    version,
    throttle,
    throttleApplied,
    mobile,
    device: device ?? null,
    env,
    errors,
    clickNote,
    codecless,
    ...out,
  };
}


async function clickPrimary(page) {
  const button = page.getByTestId('primary-action');
  try {
    await button.click({ timeout: 15_000 });
    return null;
  } catch {
console.log('Playwright input pipeline unresponsive, dispatching click directly');
}
  try {
    await button.click({ force: true, timeout: 15_000 });
    return 'forced click (driver flake)';
  } catch {
console.warn('Playwright input pipeline unresponsive, dispatching click directly');
}

  await page.evaluate(() => {
    document.querySelector('[data-testid="primary-action"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
    );
  });
  return 'dispatched click directly (Playwright input pipeline unresponsive)';
}

/**
 * Run one cell of the matrix, never throwing.
 *
 * One engine misbehaving must not destroy the whole report - the other eleven rows are still the
 * evidence being gathered. Failures become rows rather than exceptions.
 */
async function safeRun(spec) {
  try {
    const row = await runOne(spec);
    // Let the GPU driver and the OS reclaim resources before the next launch. Without a pause,
    await new Promise((r) => setTimeout(r, 2500));
    return row;
  } catch (err) {
    return {
      ...spec,
      engineFamily: ENGINE_FAMILY[spec.engine] ?? '?',
      error: { kind: 'harness', message: String(err?.message ?? err).split('\n')[0] },
    };
  }
}

async function main() {
  const requested = arg('engines', null);
  const available = await availableEngines();
  const engines = requested
    ? requested.split(',').filter((e) => available.some((a) => a.name === e))
    : available.map((a) => a.name).filter((n) => n !== 'chromium'); // chrome ≈ chromium, skip dupes

  if (engines.length === 0) {
    console.error('No usable engines. Run: npx playwright install firefox webkit');
    process.exit(1);
  }

  console.log(`\nEngines available: ${available.map((a) => `${a.name} (${a.engine})`).join(', ')}`);
  console.log(`Running: ${engines.join(', ')}  ×  CPU throttle ${THROTTLES.join('x, ')}x`);
  console.log(`Fixture: ${FIXTURE}\n`);

  const server = await serve();
  const rows = [];

  for (const engine of engines) {
    process.stdout.write(`${engine.padEnd(9)} 1x  desktop  `);
    const row = await safeRun({ engine, throttle: 1, mobile: false });
    rows.push(row);
    report(row);
  }

  const chromiumEngines = engines.filter((e) => ENGINE_FAMILY[e] === 'Chromium');
  const primary = chromiumEngines[0];
  if (primary) {
    for (const throttle of THROTTLES.filter((t) => t > 1)) {
      process.stdout.write(`${primary.padEnd(9)} ${throttle}x  desktop  `);
      const row = await safeRun({ engine: primary, throttle, mobile: false });
      rows.push(row);
      report(row);
    }
  }

  if (primary) {
    for (const device of DEVICES) {
      process.stdout.write(`${primary.padEnd(9)} 1x  ${device.padEnd(9)}`);
      const row = await safeRun({ engine: primary, throttle: 1, mobile: true, device });
      rows.push(row);
      report(row);
    }
  }

  for (const engine of engines) {
    process.stdout.write(`${engine.padEnd(9)} 1x  MOBILE   `);
    const row = await safeRun({ engine, throttle: 1, mobile: true });
    rows.push(row);
    report(row);
  }

  await server.close();

  const md = markdown(rows, available);
  await writeFile(join(ROOT, 'fixtures', 'matrix-results.md'), md);
  await writeFile(join(ROOT, 'fixtures', 'matrix-results.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${md}\n`);

  const codecless = rows.filter((r) => r.error && r.codecless);
  const failures = rows.filter((r) => r.error && !r.codecless);
  const ok = rows.filter((r) => !r.error);

  if (codecless.length) {
    console.log(
      `\n${codecless.length} run(s) on engines with no media codecs: app loaded and degraded ` +
        `cleanly, but could not decode. Not counted as failures.`
    );
  }
  if (failures.length) {
    console.log(`\n${failures.length}/${rows.length} runs FAILED:`);
    for (const f of failures) {
      console.log(
        `  ${f.engine} ${f.throttle}x ${f.mobile ? 'mobile' : 'desktop'}: ${f.error.kind} - ${f.error.message}`
      );
    }
  }
  console.log(`\n${ok.length}/${rows.length - codecless.length} decodable runs produced a verdict.`);
  if (failures.length) process.exitCode = 1;
}

const ENGINE_FAMILY = { chrome: 'Chromium', msedge: 'Chromium', chromium: 'Chromium', firefox: 'Gecko', webkit: 'WebKit' };

function report(row) {
  if (row.error && row.codecless) {
    console.log(
      `no codecs in this build — app loaded, detected ` +
        `webgpu=${row.env.webgpu} webcodecs=${row.env.webcodecs} osc=${row.env.offscreenCanvas}, ` +
        `failed cleanly as "${row.error.kind}"`
    );
    return;
  }
  if (row.error) {
    console.log(`ERROR ${row.error.kind}: ${String(row.error.message).slice(0, 70)}`);
    return;
  }
  const gov = row.perf?.counters?.['governor.throttled'] ?? 0;
  console.log(
    `${row.verdict.contains_inappropriate_content ? 'flag' : 'clean'} ` +
      `conf=${row.verdict.confidence.toFixed(2)} ` +
      `be=${(row.backend?.backend ?? '-').padEnd(6)} ` +
      `src=${(row.stats.source === 'webcodecs' ? 'wc' : 've').padEnd(2)} ` +
      `frames=${String(row.stats.sampledFrames).padStart(3)} ` +
      `infer=${String(Math.round(row.perf?.timers?.inference?.p50 ?? 0)).padStart(4)}ms ` +
      `ttfv=${String(row.stats.timeToFirstVerdictMs).padStart(5)}ms ` +
      `tier=${row.caps?.tier ?? '-'}${gov ? ` GOVERNOR×${gov}` : ''}`
  );
}

function markdown(rows, available) {
  const lines = [
    `**Engines available on this machine:** ${available.map((a) => `${a.name} ${a.version} (${a.engine})`).join(', ')}`,
    '',
    '| Engine | Family | CPU | Viewport | Backend | Source | Model load | Infer p50 | TTFV | Total | Frames | Tier | Governor | Verdict | Conf |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    if (r.error) {
      const why = r.codecless
        ? `no codecs in build — clean *${r.error.kind}*`
        : `**${r.error.kind}**`;
      lines.push(
        `| \`${r.engine}\` | ${r.engineFamily} | ${r.throttle}× | ${r.device ?? (r.mobile ? 'mobile' : 'desktop')} | ${r.env?.webgpu ? 'webgpu' : r.env?.offscreenCanvas === false ? 'no-osc' : '-'} | - | - | - | - | - | - | - | - | ${why} | - |`
      );
      continue;
    }
    const gov = r.perf?.counters?.['governor.throttled'] ?? 0;
    const cpu = r.throttle > 1 ? (r.throttleApplied ? `${r.throttle}×` : `${r.throttle}× n/a`) : '1×';
    lines.push(
      `| \`${r.engine}\` | ${r.engineFamily} | ${cpu} | ${r.device ?? (r.mobile ? 'mobile' : 'desktop')} | ${r.backend?.backend ?? '-'} | ${r.stats.source === 'webcodecs' ? 'WebCodecs' : '`<video>`' } | ${Math.round(r.backend?.modelLoadMs ?? 0)} ms | ${Math.round(r.perf?.timers?.inference?.p50 ?? 0)} ms | ${r.stats.timeToFirstVerdictMs} ms | ${r.stats.elapsedMs} ms | ${r.stats.sampledFrames} | ${r.caps?.tier ?? '-'} | ${gov ? `fired ×${gov}` : '—'} | ${r.verdict.contains_inappropriate_content ? '**flagged**' : 'clean'} | ${r.verdict.confidence.toFixed(2)} |`
    );
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('\n[matrix] FAILED:', err);
  process.exit(1);
});
