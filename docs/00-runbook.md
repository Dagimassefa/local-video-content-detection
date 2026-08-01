# Runbook — every command, and how to reproduce every number

Every figure quoted in [docs/04-benchmarks.md](04-benchmarks.md) comes out of a harness in this
repository. This document is how to run them.

---

## From a fresh clone

```bash
npm install         # postinstall vendors the model weights + tfjs WASM into public/
npm run fixtures    # ~4 min — records the synthetic test clips in Chromium
```

`npm install` is required. `npm run fixtures` is only needed for the benchmark harnesses; the app
itself runs without it, using your own files or a URL.

If the postinstall step was skipped or failed — it is deliberately non-fatal, so a network blip does
not break the install — fetch the weights explicitly with `npm run models`.

---

## The application

```bash
npm run dev         # http://localhost:5173
npm run preview     # http://localhost:4173 — production build, what the benchmarks measured
```

Use `preview` if you want the numbers to match the ones in the docs. The dev server serves unminified
modules and an extra dev-only worker round trip, so its timings run slightly worse than the build.

**The first scan in a session is a cold start** — roughly 1.2 s of model load and shader compilation
before any frame is classified. Every scan after it reuses the warm model. Cold and warm figures are
reported separately in [docs/04](04-benchmarks.md); if you are comparing against them, note which one
you are looking at.

### What each fixture exercises

| File | What it demonstrates |
| --- | --- |
| `fixtures/bars-12s.mp4` | The verdict card and the raw JSON, plus the **Categories screened** panel — one screened, six struck through |
| `fixtures/long-3min.mp4` | Time-to-first-verdict ~1 s on a 3-minute video — 15× the duration, same time to answer |
| either | The timeline: evenly spaced ticks are Phase A, clusters are Phase B spending budget where there is signal |
| `bars-12s.mp4` | Mitigation, cycling **Blur → Block → Pre-gate → Off** |
| any | The performance panel — 3–6 long tasks, all during startup, UI stays at 60 fps |
| any | Offline operation: DevTools → Network → **Offline** → scan again. It still works. |

`bars-12s.mp4` comes back **flagged**. It is a synthetic colour-gradient test pattern, so this is a
genuine out-of-distribution **false positive**, not a demo cheat — the model is uncalibrated on
non-photographic input, which [docs/04](04-benchmarks.md) documents in detail. It does mean mitigation
can be exercised end-to-end without any real content in the repository.

### Real footage via URL

The fixtures are synthetic, which is why they misbehave. These are real, CORS-enabled, publicly hosted
clips — paste either straight into the URL box:

```
https://cdn.jsdelivr.net/gh/intel-iot-devkit/sample-videos@master/store-aisle-detection.mp4
https://cdn.jsdelivr.net/gh/intel-iot-devkit/sample-videos@master/people-detection.mp4
```

The first comes back **clean at 0.93** on real retail CCTV — evidence the model is not simply flagging
everything. The second **false-positives at 0.70** on clothed pedestrians, which is the documented
skin-area bias. The pair is more informative than either alone. Full table in
[docs/04](04-benchmarks.md#spot-check-on-real-footage).

This also exercises the *other* frame source: URLs stream via `<video>` range requests rather than the
WebCodecs path, so the badge under the progress bar changes to `video-element`.

**YouTube links do not work.** A watch page is HTML, and the underlying media is signed, expiring
DASH/HLS served without CORS headers, so the browser refuses to let any script read the pixels. That is
the reported `cors` error path, not a bug — and no client-side tool of any kind can work around it.

---

## Tests

```bash
npm test            # 171 tests, 10 files, ~0.8 s
npm run typecheck   # tsc --noEmit
```

These cover the *decision* logic — sampling policy, confidence bounds and monotonicity, hash
invariance, governor idempotence, category composition. No browser and no GPU, which is why they run in
under a second.

---

## The measurement harnesses

**Build once first, then use the `:only` variants.** `npm run bench`, `verify` and `matrix` each run
`vite build` before doing anything, and a cold Vite build takes ~55 s. Paying that three times wastes
about three minutes.

```bash
# 1. Build once.
npm run build            # ~1 min cold (tsc + vite)

# 2. Then the harnesses, skipping the rebuild.
npm run bench:only       # ~90 s   → fixtures/bench-results.md + screenshots
npm run matrix:only      # ~8 min  → fixtures/matrix-results.md
npm run verify:only      # ~2 min  → prints 13/13
```

Each opens real browser windows and takes focus while it runs.

| Harness | What it does | Final line on success |
| --- | --- | --- |
| `bench:only` | Drives the real app over every fixture and emits the benchmark table | `All 5 fixtures scanned successfully.` |
| `verify:only` | Asserts the claims the README makes — locality, offline operation, clean cancellation, no leaks, specific errors | `13/13 checks passed.` |
| `matrix:only` | Runs across every installed browser engine, plus CPU-throttled and device-descriptor variants | `N/N decodable runs produced a verdict.` |

These are genuine end-to-end tests rather than smoke tests: they load fixtures through the real file
input, click the real button, and read the verdict out of the real store. Between them they found
eleven bugs that passed both typecheck and the unit suite — written up in
[docs/03](03-tradeoffs-and-alternatives.md#bugs-the-harnesses-found).

**If you see the Vite build output and then nothing, the harness has not started yet.** The browser work
happens after the build and takes another minute or two with no output in between. Don't Ctrl+C it. If
the prompt has genuinely returned early — PowerShell sometimes flushes output after the prompt — check
whether `fixtures/bench-results.md` has a fresh timestamp, and re-run if not.

Prefixing with `HEADLESS=1` keeps the browsers from appearing, but headless timings are meaningless
(SwiftShader, no WebGPU adapter). Use it for pass/fail lines only, never for numbers.

### Reading the output without re-running

```bash
cat fixtures/bench-results.md
cat fixtures/matrix-results.md
```

[docs/04-benchmarks.md](04-benchmarks.md) contains the same tables written up with the caveats attached,
which is usually the more useful read.

---

## The violence model evaluation

```bash
npm run models:violence   # vendors the 86.8 MB checkpoint — not fetched by default
npm run eval:violence
```

This is the fitness gate the violence detector failed, and it is reproducible end to end. Two checks,
both failing:

- **Discrimination** — logits move **1.26** across inputs as different as pure black, pure white,
  saturated colour and pure random noise. Probabilities never leave `[0.27, 0.73]`.
- **Label order** — sixteen portraits of people split **8/8**, every score between 0.23 and 0.68, so the
  label mapping cannot even be confirmed, because the model has no opinion to read off.

int8 and q4f16 behave identically, so this is the checkpoint rather than the quantisation. The full
analysis, including why the published 98.8% accuracy is most likely frame leakage across the dataset
split, is in [docs/02](02-model-selection.md#violence-detection-a-model-evaluated-and-rejected).

The detector can still be switched on in the UI, under **Detectors**. It is worth doing once: because
the aggregator takes the worst category, a violence score idling near 0.65 pushes essentially every
frame over the threshold and buries the NSFW detector underneath it. That is the reason it ships
disabled.

---

## Running on a real handset

```bash
npm run mobile       # builds, then prints a LAN URL
```

Open the printed URL on a phone on the same Wi-Fi, scan a clip, then tap **Copy as Markdown** in the
performance card to get a real-device measurement.

Note that `http://` on a LAN IP is not a secure context, so the app takes the WebGL/WASM fallback path
rather than WebGPU — which is what a mid-range Android would use anyway. No physical handset was
available while this was built, so [docs/04](04-benchmarks.md) reports emulated device descriptors and
says so; this is the path to replacing them with a real number.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Model fails to load | Weights missing — run `npm run models` to re-vendor them |
| Blank page on `preview` | No production build yet — run `npm run build` first |
| Scan errors on a URL with `cors` | The host is not sending `Access-Control-Allow-Origin`. Reported case, not a bug |
| `bench`/`matrix` appears to hang after the build | It hasn't; the browser phase produces no output for a minute or two |
| Firefox mobile cell times out in `matrix` | Known driver flake under many sequential launches; completes in ~12 s run standalone |
