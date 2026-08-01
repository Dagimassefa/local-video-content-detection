#!/usr/bin/env node
/**
 * Generates synthetic test videos into `fixtures/`.
 *
 * Why synthetic, and why a script rather than committed media:
 *
 *  - **No NSFW assets are ever committed to this repository.** Not one. Verifying the positive
 *    detection path requires content nobody should be checking into source control, so that
 *    part of testing is done against clips a reviewer supplies locally (see
 *    `public/samples/README.md`), while everything mechanical - decoding, sampling, budgets,
 *    dedupe, the negative verdict path, the perf numbers - is verified against these.
 *  - They are deterministic, so benchmark runs are comparable to each other.
 *  - They deliberately span the cases that exercise different code paths: an MP4 for the
 *    hardware WebCodecs path, a WebM for the `<video>` fallback, a near-static clip to
 *    demonstrate perceptual dedupe, and a long one to demonstrate that time-to-first-verdict
 *    does not grow with duration.
 *
 * Recording happens inside Chromium via `canvas.captureStream()` + `MediaRecorder`, because
 * that is the one video encoder guaranteed to be present in this project's toolchain.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures');

const CLIPS = [
  {
    name: 'bars-12s.mp4',
    mime: 'video/mp4;codecs=avc1.42E01E',
    seconds: 12,
    width: 640,
    height: 360,
    pattern: 'bars',
    note: 'H.264 MP4 - exercises the WebCodecs hardware decode path and keyframe indexing.',
  },
  {
    name: 'bars-12s.webm',
    mime: 'video/webm;codecs=vp9',
    seconds: 12,
    width: 640,
    height: 360,
    pattern: 'bars',
    note: 'WebM - not ISO-BMFF, so it forces the seek-based <video> fallback.',
  },
  {
    name: 'static-20s.webm',
    mime: 'video/webm;codecs=vp9',
    seconds: 20,
    width: 640,
    height: 360,
    pattern: 'static',
    note: 'Near-static - almost every sample should be caught by perceptual dedupe.',
  },
  {
    name: 'scenes-30s.mp4',
    mime: 'video/mp4;codecs=avc1.42E01E',
    seconds: 30,
    width: 640,
    height: 360,
    pattern: 'scenes',
    note: 'Hard scene cuts every 3s - produces a dense keyframe index.',
  },
  {
    name: 'long-3min.mp4',
    mime: 'video/mp4;codecs=avc1.42E01E',
    seconds: 180,
    width: 480,
    height: 270,
    pattern: 'scenes',
    note: 'Long clip - demonstrates that time-to-first-verdict does not grow with duration. Recording takes 3 real minutes.',
  },
];

/** `--only=name.mp4` records a single clip; recording all of them takes several minutes. */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/**
 * Runs inside the page. Draws an animated canvas and records it.
 *
 * `requestAnimationFrame` rather than a timer: MediaRecorder captures from the compositor, so
 * frames only exist when the page actually paints.
 */
async function record({ mime, seconds, width, height, pattern }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  if (!MediaRecorder.isTypeSupported(mime)) {
    return { unsupported: mime };
  }

  const stream = canvas.captureStream(25);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  const start = performance.now();
  let raf = 0;

  const draw = () => {
    const t = (performance.now() - start) / 1000;

    if (pattern === 'static') {
      // One flat field plus a tiny clock, so the file is not literally identical frames (which
      // would be an unrealistically easy case) but is still perceptually unchanging.
      ctx.fillStyle = '#2a4a7a';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px monospace';
      ctx.fillText(t.toFixed(1), 12, 28);
    } else if (pattern === 'scenes') {
      // A hard cut every 3 seconds. Encoders insert a keyframe at each cut, which is what
      // gives the sampler a rich index to snap onto.
      const scene = Math.floor(t / 3);
      const hues = [8, 48, 96, 150, 200, 250, 290, 330, 20, 70];
      ctx.fillStyle = `hsl(${hues[scene % hues.length]}, 55%, 42%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 6; i++) {
        const s = 30 + ((i * 37 + scene * 53) % 90);
        ctx.fillRect((i * 113 + scene * 61) % width, (i * 71 + scene * 29) % height, s, s * 0.6);
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px monospace';
      ctx.fillText(`scene ${scene}`, 16, height - 20);
    } else {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, `hsl(${(t * 40) % 360}, 60%, 45%)`);
      grad.addColorStop(1, `hsl(${(t * 40 + 120) % 360}, 60%, 25%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
        const x = (i * (width / 8) + t * 90) % width;
        ctx.fillRect(x, 0, width / 16, height);
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px monospace';
      ctx.fillText(`t=${t.toFixed(1)}s`, 16, 34);
    }

    if (t < seconds) raf = requestAnimationFrame(draw);
  };

  recorder.start(500);
  raf = requestAnimationFrame(draw);
  await new Promise((r) => setTimeout(r, seconds * 1000 + 350));
  cancelAnimationFrame(raf);
  recorder.stop();
  await finished;

  const blob = new Blob(chunks, { type: mime });
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return { bytes: Array.from(bytes), type: mime };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { browser, label, version } = await launchBrowser();
  console.log(`[fixtures] recording with ${label} ${version}`);
  const page = await browser.newPage();
  await page.goto('about:blank');

  const written = [];
  for (const clip of CLIPS.filter((c) => !ONLY || c.name === ONLY)) {
    process.stdout.write(`[fixtures] recording ${clip.name} (${clip.seconds}s)... `);
    const result = await page.evaluate(record, clip);
    if (result.unsupported) {
      console.log(`SKIPPED - ${result.unsupported} not supported by this Chromium`);
      continue;
    }
    const buffer = Buffer.from(result.bytes);
    await writeFile(join(OUT, clip.name), buffer);
    written.push({ name: clip.name, bytes: buffer.byteLength, note: clip.note });
    console.log(`${(buffer.byteLength / 1024).toFixed(0)} KB`);
  }

  await browser.close();

  // Preserve the manifest when only one clip was re-recorded.
  if (ONLY) {
    console.log(`[fixtures] wrote ${written.length} clip(s); README.md left unchanged (--only)`);
    return;
  }

  await writeFile(
    join(OUT, 'README.md'),
    [
      '# Test fixtures (generated - do not commit)',
      '',
      'Regenerate with `node scripts/make-fixtures.mjs`.',
      '',
      'These are synthetic clips used to verify the pipeline and produce the benchmark numbers in',
      '`docs/04-benchmarks.md`. **No NSFW media is committed to this repository.** Verifying the',
      'positive detection path requires clips you supply yourself - see `public/samples/README.md`.',
      '',
      ...written.map((w) => `- **${w.name}** (${(w.bytes / 1024).toFixed(0)} KB) - ${w.note}`),
      '',
    ].join('\n')
  );

  console.log(`[fixtures] wrote ${written.length} clips to fixtures/`);
}

main().catch((err) => {
  console.error('[fixtures] FAILED:', err);
  process.exit(1);
});
