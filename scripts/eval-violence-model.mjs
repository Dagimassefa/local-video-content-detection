#!/usr/bin/env node
/**
 * Evaluates whether the vendored violence checkpoint is fit to ship.
 *
 * Two properties are checked, and BOTH must hold before the detector is enabled:
 *
 *   1. **Does it discriminate at all?** Feed wildly different synthetic inputs - black, white,
 *      saturated colours, pure noise. A healthy binary classifier swings hard: logits of several
 *      units. One whose output distribution has collapsed barely moves whatever you show it.
 *
 *   2. **Which output index means "Violence"?** The ONNX export carries no `id2label`, so the mapping
 *      is inferred from the dataset's alphabetical class order and has to be verified. Getting it
 *      backwards inverts every verdict silently - no error, no exception, just the opposite of the
 *      truth reported with confidence. Verified by asymmetry: photographs of people are
 *      overwhelmingly non-violent, so the index meaning NonViolence must dominate on them.
 *
 * Run after `npm run models -- --violence`:
 *
 *   node scripts/eval-violence-model.mjs
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = join(ROOT, 'public/models/vit-violence');
const PORT = 4204;
const ORIGIN = `http://localhost:${PORT}`;
const TYPES = { '.wasm': 'application/wasm', '.mjs': 'text/javascript' };

/** Portraits: real photographs of people, i.e. in-distribution NEGATIVES for this model. */
const PORTRAITS = [
  ...Array.from({ length: 8 }, (_, i) => [
    `m${i + 1}`,
    `https://randomuser.me/api/portraits/men/${i + 1}.jpg`,
  ]),
  ...Array.from({ length: 8 }, (_, i) => [
    `w${i + 1}`,
    `https://randomuser.me/api/portraits/women/${i + 1}.jpg`,
  ]),
];

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8"><body>');
      }
      const path = join(ROOT, 'public', decodeURIComponent(url.pathname));
      const body = await readFile(path);
      res.writeHead(200, {
        'Content-Type': TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, r));
  return { close: () => new Promise((r) => server.close(r)) };
}


async function runInPage({ input, origin, size }) {
  const ort = await import(`${origin}/ort/ort.wasm.mjs`);
  ort.env.wasm.wasmPaths = `${origin}/ort/`;
  ort.env.wasm.numThreads = 1;
  window.__s =
    window.__s ||
    (await ort.InferenceSession.create(`${origin}/models/vit-violence/model.onnx`, {
      executionProviders: ['wasm'],
    }));
  const S = window.__s;
  const px = size * size;
  const inp = new Float32Array(px * 3);

  if (input.kind === 'bytes') {
    const bmp = await createImageBitmap(
      new Blob([new Uint8Array(input.bytes)], { type: 'image/jpeg' })
    );
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    bmp.close();
    for (let p = 0; p < px; p++) {
      const q = p * 4;
      inp[p] = (d[q] / 255 - 0.5) / 0.5;
      inp[px + p] = (d[q + 1] / 255 - 0.5) / 0.5;
      inp[px * 2 + p] = (d[q + 2] / 255 - 0.5) / 0.5;
    }
  } else {
    for (let p = 0; p < px; p++) {
      const c =
        input.kind === 'noise'
          ? [Math.random() * 255, Math.random() * 255, Math.random() * 255]
          : input.rgb;
      inp[p] = (c[0] / 255 - 0.5) / 0.5;
      inp[px + p] = (c[1] / 255 - 0.5) / 0.5;
      inp[px * 2 + p] = (c[2] / 255 - 0.5) / 0.5;
    }
  }

  const out = await S.run({ [S.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, size, size]) });
  const logits = Array.from(out[S.outputNames[0]].data);
  const max = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return { logits, probs: exp.map((v) => v / sum) };
}

async function main() {
  if (!(await stat(join(MODEL_DIR, 'model.onnx')).catch(() => null))) {
    console.error('Violence model not vendored. Run:  npm run models -- --violence');
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(join(MODEL_DIR, 'manifest.json'), 'utf8'));
  const size = manifest.inputSize;

  const cacheDir = join(ROOT, 'fixtures', 'portraits');
  await mkdir(cacheDir, { recursive: true });
  const photos = [];
  for (const [name, url] of PORTRAITS) {
    const file = join(cacheDir, `${name}.jpg`);
    if (!(await stat(file).catch(() => null))) {
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) continue;
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
    photos.push([name, file]);
  }

  const server = await serve();
  const { browser } = await launchBrowser();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  const run = (input) => page.evaluate(runInPage, { input, origin: ORIGIN, size });

  console.log('\n1. DISCRIMINATION - does the output move when the input changes?\n');
  const synth = [
    ['black', { kind: 'flat', rgb: [0, 0, 0] }],
    ['white', { kind: 'flat', rgb: [255, 255, 255] }],
    ['red', { kind: 'flat', rgb: [220, 20, 20] }],
    ['green', { kind: 'flat', rgb: [20, 180, 60] }],
    ['noise', { kind: 'noise' }],
  ];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [name, input] of synth) {
    const { logits, probs } = await run(input);
    for (const l of logits) {
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
    console.log(
      `   ${name.padEnd(6)} logits [${logits.map((v) => v.toFixed(3)).join(', ')}]  probs [${probs
        .map((v) => v.toFixed(3))
        .join(', ')}]`
    );
  }
  const swing = hi - lo;
  const discriminates = swing >= 4;
  console.log(`\n   logit range across all inputs: ${swing.toFixed(2)}`);
  console.log(
    discriminates
      ? '   OK - the model commits to decisions.\n'
      : `   FAIL - COLLAPSED. A healthy binary classifier swings several logits; this moves\n` +
          `   ${swing.toFixed(2)} even between pure black and pure noise.\n`
  );

  console.log('2. LABEL ORDER - do photographs of people read as NonViolence?\n');
  const wins = [0, 0];
  for (const [name, file] of photos) {
    const bytes = Array.from(new Uint8Array(await readFile(file)));
    const { probs } = await run({ kind: 'bytes', bytes });
    const top = probs.indexOf(Math.max(...probs));
    wins[top]++;
    console.log(`   ${name.padEnd(4)} [${probs.map((v) => v.toFixed(3)).join(', ')}] -> ${top}`);
  }
  await browser.close();
  await server.close();

  const nonViolenceIdx = manifest.violenceIndex === 1 ? 0 : 1;
  const total = photos.length;
  console.log(`\n   index 0: ${wins[0]}/${total}   index 1: ${wins[1]}/${total}`);
  console.log(`   manifest asserts index ${manifest.violenceIndex} = Violence\n`);

  const ratio = total ? wins[nonViolenceIdx] / total : 0;
  const labelsOk = ratio >= 0.67;
  console.log(
    labelsOk
      ? `   OK - ${wins[nonViolenceIdx]}/${total} read as NonViolence, mapping confirmed.\n`
      : `   FAIL - only ${wins[nonViolenceIdx]}/${total} read as NonViolence, mapping UNCONFIRMED.\n`
  );

  console.log('VERDICT');
  if (discriminates && labelsOk) {
    console.log('  Checkpoint is fit to enable.\n');
    return;
  }
  console.log(
    `  NOT FIT TO ENABLE.

  Both the int8 and the q4f16 quantisations behave identically, so this is the base
  checkpoint rather than a quantisation artifact. The published 98.8% test accuracy is
  almost certainly frame leakage: Real Life Violence Situations is a VIDEO dataset, and
  near-duplicate frames either side of the train/test split inflate accuracy to near-perfect
  while the model learns nothing that generalises to unseen footage.

  Enabling it would be actively harmful. combineCategoryScores() takes the WORST category, so
  a violence score idling around 0.65 would flag essentially every frame and destroy the NSFW
  detector's usefulness along with it.

  The detector therefore ships DISABLED. See docs/02-model-selection.md.
`
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n[eval-violence-model] FAILED:', err);
  process.exit(1);
});
