/**
 * End-to-end verification and benchmark harness.
 *
 * Drives the real application in a real browser: loads a fixture through the actual file input,
 * clicks the actual scan button, and reads the verdict out of the actual UI. Nothing is mocked
 * and nothing is stubbed, so a pass here means the whole chain works - worker startup, backend
 * selection, weight loading, demuxing, hardware decode, preprocessing, inference, aggregation,
 * and rendering.
 *
 * It is also where the numbers in `docs/04-benchmarks.md` come from. Having the harness collect
 * them means they are reproducible by anyone running `npm run bench` rather than being timings
 * someone once observed and typed in.
 *
 * Usage:
 *   npm run bench                 # every fixture, default policy
 *   npm run bench -- --backend=wasm
 *   HEADLESS=1 npm run bench      # CI: assertions still valid, timings are not
 */

import { readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BACKEND = arg('backend', 'auto');
const POLICY = arg('policy', 'balanced');
const ONLY = arg('only', null);
const SCAN_TIMEOUT_MS = Number(arg('timeout', '120000'));

/** Serve `dist/` so the benchmark measures the production build, not the dev server. */
async function serveDist(port = 4178) {
  const { readFile, stat } = await import('node:fs/promises');
  const dist = join(ROOT, 'dist');

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = join(dist, decodeURIComponent(url.pathname));
      const info = await stat(path).catch(() => null);
      if (!info || info.isDirectory()) path = join(dist, 'index.html');

      const ext = path.slice(path.lastIndexOf('.'));
      const body = await readFile(path);
      res.writeHead(200, {
        // The weight shard has no extension; octet-stream is what tfjs expects anyway.
        'Content-Type': types[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((r) => server.listen(port, r));
  return { url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const names = ONLY
    ? [ONLY]
    : (await readdir(FIXTURES)).filter((f) => /\.(mp4|webm|mov|mkv)$/i.test(f)).sort();

  if (names.length === 0) {
    console.error('No fixtures found. Run `node scripts/make-fixtures.mjs` first.');
    process.exit(1);
  }

  const server = await serveDist();
  const { browser, label, version } = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(server.url, { waitUntil: 'networkidle' });

  // What the browser actually reports about itself, so the benchmark table can state the
  // environment rather than asserting it.
  const env = await page.evaluate(async () => {
    let adapter = null;
    try {
      adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    } catch {
      adapter = null;
    }
    let renderer = 'n/a';
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      if (gl && info) renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    } catch {
      /* ignore */
    }
    return {
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      webgpu: adapter != null,
      webcodecs: typeof VideoDecoder !== 'undefined',
      renderer,
    };
  });

  console.log(`\n=== ${label} ${version} ===`);
  console.log(`UA:        ${env.userAgent}`);
  console.log(`GPU:       ${env.renderer}`);
  console.log(`cores=${env.cores}  memory=${env.deviceMemory ?? '?'}GB  webgpu=${env.webgpu}  webcodecs=${env.webcodecs}`);
  console.log(`backend=${BACKEND}  policy=${POLICY}\n`);

  const rows = [];

  for (const name of names) {
    process.stdout.write(`${name.padEnd(22)} `);

    // Fresh page per fixture: a warm model would make the first run's load time incomparable
    // to the others, and cold-vs-warm is itself one of the numbers worth reporting.
    const scanPage = await context.newPage();
    scanPage.on('pageerror', (err) => consoleErrors.push(`[${name}] ${err.message}`));
    await scanPage.goto(server.url, { waitUntil: 'networkidle' });

    // Configure through the store, which is exactly what the UI controls do.
    await scanPage.evaluate(
      ({ backend, policy }) => {
        const w = window;
        w.__vcd?.setBackendPref?.(backend);
        w.__vcd?.setPolicy?.(policy);
      },
      { backend: BACKEND, policy: POLICY }
    );

    await scanPage.setInputFiles('input[type=file]', join(FIXTURES, name));
    const started = Date.now();
    await scanPage.getByTestId('primary-action').click();

    let outcome;
    try {
      // Wait for the store to report a finalized result - the same signal the UI uses to stop
      // showing "preliminary".
      outcome = await scanPage.waitForFunction(
        () => {
          const s = window.__vcd?.getState?.();
          if (s?.error) return { error: s.error };
          if (s?.result?.finalized) {
            return {
              verdict: s.result.verdict,
              stats: s.result.stats,
              segments: s.result.segments.length,
              backend: s.backend,
              perf: s.perf,
              meta: s.meta,
              decision: s.sourceDecision,
            };
          }
          return false;
        },
        null,
        { timeout: SCAN_TIMEOUT_MS, polling: 200 }
      );
    } catch (err) {
      console.log(`TIMEOUT after ${SCAN_TIMEOUT_MS}ms`);
      rows.push({ name, error: `timeout: ${err.message.split('\n')[0]}` });
      await scanPage.close();
      continue;
    }

    const data = await outcome.jsonValue();
    const wallMs = Date.now() - started;

    if (data.error) {
      console.log(`ERROR - ${data.error.kind}: ${data.error.message}`);
      rows.push({ name, error: `${data.error.kind}: ${data.error.message}` });
      await scanPage.close();
      continue;
    }

    const longTasks = await scanPage.evaluate(() => window.__vcdLongTasks ?? null);

    console.log(
      `${data.verdict.contains_inappropriate_content ? 'FLAGGED' : 'clean  '} ` +
        `conf=${data.verdict.confidence.toFixed(2)} ` +
        `frames=${data.stats.sampledFrames}(${data.stats.dedupedFrames}dup) ` +
        `ttfv=${data.stats.timeToFirstVerdictMs}ms ` +
        `total=${data.stats.elapsedMs}ms ` +
        `src=${data.stats.source} ` +
        `be=${data.backend?.backend}`
    );

    rows.push({ name, wallMs, longTasks, ...data });
    await scanPage.screenshot({
      path: join(ROOT, 'fixtures', `screenshot-${name.replace(/\W+/g, '-')}.png`),
      fullPage: true,
    });
    await scanPage.close();
  }

  await browser.close();
  await server.close();

  const report = { env, backend: BACKEND, policy: POLICY, rows };
  await writeFile(join(ROOT, 'fixtures', 'bench-results.json'), JSON.stringify(report, null, 2));

  console.log(`\n${markdownTable(report)}\n`);
  await writeFile(join(ROOT, 'fixtures', 'bench-results.md'), markdownTable(report));

  if (consoleErrors.length) {
    console.log('Console errors observed:');
    for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  - ${e}`);
  }

  const failures = rows.filter((r) => r.error);
  if (failures.length) {
    console.error(`\n${failures.length}/${rows.length} fixtures failed.`);
    process.exit(1);
  }
  console.log(`All ${rows.length} fixtures scanned successfully.`);
}

function markdownTable({ env, backend, policy, rows }) {
  const lines = [
    `**Browser:** ${env.userAgent}`,
    '',
    `**GPU:** ${env.renderer} - **cores:** ${env.cores} - **deviceMemory:** ${env.deviceMemory ?? 'n/a'} GB - **WebGPU:** ${env.webgpu ? 'yes' : 'no'} - **WebCodecs:** ${env.webcodecs ? 'yes' : 'no'}`,
    '',
    `**Requested backend:** \`${backend}\` - **policy:** \`${policy}\``,
    '',
    '| Fixture | Duration | Source | Backend | Model load | Warm-up | TTFV | Total | Frames (dup) | Decode p50/p95 | Infer p50/p95 | Coverage | Verdict | Conf | Stop |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const ms = (n) => (n === null || n === undefined ? '-' : `${Math.round(n)} ms`);
  const t = (perf, key) =>
    perf?.timers?.[key] ? `${perf.timers[key].p50} / ${perf.timers[key].p95}` : '-';

  for (const r of rows) {
    if (r.error) {
      lines.push(`| \`${r.name}\` | - | - | - | - | - | - | - | - | - | - | - | **error** | - | ${r.error} |`);
      continue;
    }
    lines.push(
      `| \`${r.name}\` | ${(r.stats.durationMs / 1000).toFixed(1)} s | ${r.stats.source} | ${r.backend?.backend ?? '-'} | ${ms(r.backend?.modelLoadMs)} | ${ms(r.backend?.warmupMs)} | ${ms(r.stats.timeToFirstVerdictMs)} | ${ms(r.stats.elapsedMs)} | ${r.stats.sampledFrames} (${r.stats.dedupedFrames}) | ${t(r.perf, 'decode')} | ${t(r.perf, 'inference')} | ${Math.round(r.stats.coverage * 100)}% | ${r.verdict.contains_inappropriate_content ? '**flagged**' : 'clean'} | ${r.verdict.confidence.toFixed(2)} | ${r.stats.stopReason} |`
    );
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('\n[bench] FAILED:', err);
  process.exit(1);
});
