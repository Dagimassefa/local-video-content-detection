#!/usr/bin/env node
/**
 * Serves the production build on the local network so it can be opened on a real phone.
 *
 * This exists because the one gap the automated matrix cannot close is physical hardware. CPU
 * throttling, device descriptors and WebKit cover the CPU, form-factor and engine dimensions; none of
 * them covers a mobile GPU, a mobile video decode block, or thermal behaviour. The only way to get
 * those numbers is to run it on a handset.
 *
 * So rather than leaving that as a caveat, this makes it a one-command exercise: start the server,
 * open the printed URL on a phone on the same Wi-Fi, run a scan, and press **Copy as Markdown** in the
 * performance panel. That produces exactly the table format used in `docs/04-benchmarks.md`, so a real
 * device row can be pasted straight in.
 *
 *   npm run mobile
 *
 * Two constraints worth knowing before you try it:
 *
 *  - **WebGPU and the Cache API need a secure context.** `http://` on a LAN IP is not one, so on a
 *    phone the app will fall back to WebGL or WASM and cannot use Cache Storage. That is a *realistic*
 *    low-tier scenario and still a useful measurement, but if you want the WebGPU path, tunnel it over
 *    HTTPS (`npx localtunnel --port 4200`, `cloudflared tunnel`, or similar) and use that URL instead.
 *  - **iOS Safari requires a user gesture** before it will decode video. Tapping the button provides
 *    it, so this only matters if you try to automate the page.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 4200);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) found.push({ name, address: addr.address });
    }
  }
  return found;
}

async function main() {
  if ((await stat(DIST).catch(() => null)) === null) {
    console.error('No dist/ found. Run `npm run build` first.');
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = join(DIST, decodeURIComponent(url.pathname));
      const info = await stat(path).catch(() => null);
      if (!info || info.isDirectory()) path = join(DIST, 'index.html');
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  // 0.0.0.0 so the phone can reach it, not just this machine.
  await new Promise((r) => server.listen(PORT, '0.0.0.0', r));

  const addresses = lanAddresses();
  console.log('\n  Production build served for real-device testing\n');
  console.log(`  this machine   http://localhost:${PORT}`);
  for (const { name, address } of addresses) {
    console.log(`  ${name.padEnd(14)} http://${address}:${PORT}`);
  }
  if (addresses.length === 0) {
    console.log('  (no LAN address found - check you are connected to a network)');
  }

  console.log(`
  On the phone:
    1. Join the same Wi-Fi as this machine and open one of the LAN URLs above.
    2. Pick a video and tap "Scan video".
    3. In the Performance card, tap "Copy as Markdown" and send it to yourself.
       That is the exact row format used in docs/04-benchmarks.md.

  What to record alongside the numbers:
    - handset model and OS version
    - browser and version
    - the resolved backend shown in the Performance card (webgpu / webgl / wasm)
    - whether "WebCodecs" or "video-element" appears as the frame source

  Note: http:// on a LAN IP is not a secure context, so WebGPU and Cache Storage are
  unavailable and the app will fall back to WebGL or WASM. That is a realistic low-tier
  measurement. For the WebGPU path, tunnel this port over HTTPS and use that URL.

  Ctrl+C to stop.
`);
}

main().catch((err) => {
  console.error('[serve-lan] FAILED:', err);
  process.exit(1);
});
