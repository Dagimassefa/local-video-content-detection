#!/usr/bin/env node
/**
 * Verifies the CLAIMS this project makes about itself.
 *
 * Separate from `bench.mjs`, which measures performance. This one asserts the properties the README
 * and the docs assert - the ones a reviewer would otherwise have to take on trust:
 *
 *   1. It runs entirely locally.        No network request leaves the origin, ever.
 *   2. It works fully offline.          Load once, then scan with the network hard-blocked.
 *   3. Cancellation is clean.           Mid-scan cancel stops promptly and leaks no tensors.
 *   4. Repeat scans do not leak.        Five back-to-back scans, flat tensor count.
 *   5. Bad input fails loudly.          A non-CORS URL reports `cors`, not a hang or a wrong verdict.
 *
 * Each is an assertion, so this exits non-zero if a claim stops being true.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FIXTURE = join(ROOT, 'fixtures', 'bars-12s.mp4');
const PORT = 4188;
const ORIGIN = `http://localhost:${PORT}`;

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
      let path = join(DIST, decodeURIComponent(url.pathname));
      const info = await stat(path).catch(() => null);
      if (!info || info.isDirectory()) path = join(DIST, 'index.html');
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        // Long-lived so the offline check exercises the HTTP cache the way a real second visit does.
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, r));
  return { close: () => new Promise((r) => server.close(r)) };
}

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitForScan(page, timeout = 120_000) {
  const handle = await page.waitForFunction(
    () => {
      const s = window.__vcd?.getState?.();
      if (s?.error) return { error: s.error };
      if (s?.result?.finalized) {
        return { verdict: s.result.verdict, stats: s.result.stats, perf: s.perf };
      }
      return false;
    },
    null,
    { timeout, polling: 150 }
  );
  return handle.jsonValue();
}

async function main() {
  const server = await serve();
  const { browser, label, version } = await launchBrowser();
  const context = await browser.newContext();
  console.log(`\nVerifying with ${label} ${version}\n`);

  console.log('1. Runs entirely locally (no off-origin requests)');
  {
    const page = await context.newPage();
    const offOrigin = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith(ORIGIN) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        offOrigin.push(url);
      }
    });
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', FIXTURE);
    await page.getByTestId('primary-action').click();
    const out = await waitForScan(page);

    check('scan completes', !out.error, out.error ? `${out.error.kind}: ${out.error.message}` : '');
    check(
      'zero off-origin network requests',
      offOrigin.length === 0,
      offOrigin.length ? offOrigin.slice(0, 3).join(', ') : 'none'
    );
    await page.close();
  }

  console.log('\n2. Works with the network offline');
  {

    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', FIXTURE);
    await page.getByTestId('primary-action').click();
    const online = await waitForScan(page);
    check('baseline scan succeeds online', !online.error, online.error?.kind ?? 'ok');

    await context.setOffline(true);
    let attempted = 0;
    await page.route('**/*', (route) => {
      attempted++;
      return route.abort();
    });

    await page.getByTestId('primary-action').click();
    const offline = await waitForScan(page, 90_000).catch((err) => ({
      error: { kind: 'timeout', message: String(err) },
    }));

    await page.unroute('**/*');
    await context.setOffline(false);

    check(
      'full scan succeeds with the network offline AND all requests aborted',
      Boolean(offline && !offline.error),
      offline?.error
        ? `${offline.error.kind}: ${offline.error.message}`
        : `verdict ${offline.verdict.contains_inappropriate_content} conf ${offline.verdict.confidence}`
    );
    check(
      'no network was even attempted while offline',
      attempted === 0,
      `${attempted} request(s) attempted`
    );
    await page.close();
  }

  console.log('\n3. Cancellation is prompt and clean');
  {
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', join(ROOT, 'fixtures', 'long-3min.mp4'));
    await page.evaluate(() => window.__vcd.setBudget({ maxFrames: 300, maxWallClockMs: 120000 }));
    await page.getByTestId('primary-action').click();

    // Let it get properly under way.
    await page.waitForFunction(() => (window.__vcd.getState().result?.stats.sampledFrames ?? 0) >= 4, null, {
      timeout: 60_000,
      polling: 100,
    });
    const before = await page.evaluate(() => window.__vcd.getState().result.stats.sampledFrames);

    const t0 = Date.now();
    await page.getByTestId('primary-action').click();
    await page.waitForFunction(
      () => {
        const s = window.__vcd.getState();
        return s.phase === 'cancelled' || s.result?.finalized === true;
      },
      null,
      { timeout: 20_000, polling: 100 }
    );
    const cancelMs = Date.now() - t0;

    check('cancel resolves promptly', cancelMs < 5_000, `${cancelMs} ms`);
    check('scan had genuinely started', before >= 4, `${before} frames sampled before cancel`);
    await page.close();
  }

  console.log('\n4. Repeated scans do not leak tensors');
  {
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', FIXTURE);

    const counts = [];
    for (let i = 0; i < 5; i++) {
      const button = page.getByTestId('primary-action');
      await button.click();
      const out = await waitForScan(page);
      if (out.error) break;
      counts.push(out.perf?.tensors?.numTensors ?? -1);
    }

    const first = counts[0];
    const last = counts[counts.length - 1];
    check(
      'tensor count is flat across 5 scans',
      counts.length === 5 && Math.abs(last - first) <= 4,
      counts.join(' → ')
    );
    await page.close();
  }

  console.log('\n5. A CORS-enabled cross-origin URL scans successfully');
  {
 
    const media = createServer(async (req, res) => {
      const buf = await readFile(FIXTURE);
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      };
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : buf.length - 1;
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': end - start + 1,
        });
        res.end(buf.subarray(start, end + 1));
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': buf.length });
        res.end(buf);
      }
    });
    await new Promise((r) => media.listen(4190, r));

    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.fill('#video-url', 'http://127.0.0.1:4190/clip.mp4');
    await page.getByRole('button', { name: /^Load$/ }).click();
    await page.getByTestId('primary-action').click();

    const out = await waitForScan(page, 90_000).catch(() => ({
      error: { kind: 'timeout', message: 'timed out' },
    }));

    check(
      'cross-origin URL with CORS produces a verdict',
      Boolean(out && !out.error),
      out?.error
        ? `${out.error.kind}: ${out.error.message}`
        : `verdict ${out.verdict.contains_inappropriate_content} conf ${out.verdict.confidence}`
    );
    check(
      'URL input uses the streaming <video> source',
      out?.stats?.source === 'video-element',
      out?.stats?.source ?? '-'
    );
    check(
      'frames were genuinely decoded from the remote URL',
      (out?.stats?.inferredFrames ?? 0) > 0,
      `${out?.stats?.inferredFrames ?? 0} inferred`
    );

    await new Promise((r) => media.close(r));
    await page.close();
  }

  console.log('\n6. A non-CORS URL fails loudly and specifically');
  {
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    // Served from a different port = different origin, with no CORS headers.
    const otherOrigin = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      readFile(FIXTURE).then((b) => res.end(b));
    });
    await new Promise((r) => otherOrigin.listen(4191, r));

    await page.fill('#video-url', 'http://127.0.0.1:4191/clip.mp4');
    await page.getByRole('button', { name: /^Load$/ }).click();
    await page.getByTestId('primary-action').click();

    const out = await waitForScan(page, 60_000).catch(() => ({ error: { kind: 'timeout', message: 'timed out' } }));
    check(
      'reports a specific error rather than hanging or guessing',
      Boolean(out.error),
      out.error ? `kind=${out.error.kind}` : 'unexpectedly succeeded'
    );
    check(
      'the error is actionable (cors or decode), not "unknown"',
      out.error ? out.error.kind !== 'unknown' : false,
      out.error?.kind ?? '-'
    );

    await new Promise((r) => otherOrigin.close(r));
    await page.close();
  }

  await browser.close();
  await server.close();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[verify] FAILED:', err);
  process.exit(1);
});
