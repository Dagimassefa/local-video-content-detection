# Local Video Content Detection

Accepts a video by **file upload or URL** and decides whether it contains inappropriate visual
content. Everything runs on-device: the video is never uploaded, there is no inference API, and
there is no server-side processing of any kind.

```json
{
  "contains_inappropriate_content": true,
  "confidence": 0.87
}
```

---

## Deliverables

| Asked for | Where it lives |
| --- | --- |
| Working prototype, setup and usage instructions | [Setup](#setup) and [Usage](#usage), below |
| Architecture overview and key design decisions | [docs/01-architecture.md](docs/01-architecture.md) |
| Selected model, and why it suits a mobile implementation | [docs/02-model-selection.md](docs/02-model-selection.md) |
| Performance tradeoffs and alternatives considered | [docs/03-tradeoffs-and-alternatives.md](docs/03-tradeoffs-and-alternatives.md) |
| Performance measurements, with device and browser stated | [docs/04-benchmarks.md](docs/04-benchmarks.md) |
| Limitations, edge cases, and the path to mobile production | [docs/05-limitations-and-production-path.md](docs/05-limitations-and-production-path.md) |
| Proposal for how the browser should respond on detection | [docs/06-mitigation-proposal.md](docs/06-mitigation-proposal.md) |
| Screen recording of the walkthrough | [Loom walkthrough](https://www.loom.com/share/f7e8975bb0944337b15629fd68410883) |

If you only have ten minutes: [docs/00-runbook.md](docs/00-runbook.md) is every command in order and how
to reproduce each number quoted, and [docs/03](docs/03-tradeoffs-and-alternatives.md) is where the
reasoning is densest.

---

## What "inappropriate" is defined to mean

The brief does not define the term, and it cannot be defined absolutely — inappropriateness is a
property of a video *relative to a policy*. So the service screens a **declared taxonomy** and reports
its own coverage rather than making a vague claim:

| Screened | Implemented but disabled | Not screened |
| --- | --- | --- |
| ✅ **Sexual content** — NSFWJS MobileNetV2, five classes, policy-weighted | ⚠️ **Violence** — detector built on ONNX Runtime Web; the only public checkpoint **failed evaluation** and is off | Gore · Weapons · Self-harm · Hate imagery · Drug use |

Both lists ship in `ScanResult.stats` (`screenedCategories` / `unscreenedCategories`) and are shown
next to the verdict in the UI, so a clean result provably means *"no sexual content found"* rather than
*"nothing wrong with this video"*. Adding a category is a `Detector` registration, not a refactor —
see [`core/categories.ts`](src/core/categories.ts) and
[`core/detector/Detector.ts`](src/core/detector/Detector.ts), and
[docs/05](docs/05-limitations-and-production-path.md#why-a-second-weaker-detector-was-deliberately-not-shipped)
for why a weak second detector (COCO-SSD "knife") was **rejected** rather than shipped for the sake of
a checkbox.

**Violence detection is implemented but not enabled.** The capability is real — a second runtime (ONNX
Runtime Web) and a second model family (ViT) composed through the same `Detector` seam — but the only
publicly available checkpoint moves its logits by **1.26 across inputs as different as pure black and
pure noise**, and splits **8/8 on sixteen portraits of people**. Since the aggregator takes the worst
category, enabling it would flag every frame. Reproduce with `npm run models:violence && npm run
eval:violence`; the full write-up is in
[docs/02](docs/02-model-selection.md#violence-detection-a-model-evaluated-and-rejected).

CSAM is deliberately out of scope and is not a gap to be filled by this approach: it requires
hash-matching against controlled databases, mandatory reporting, and legal process that are
categorically server-side.

Second caveat, equally important: **client-side detection is advisory, not enforcement.** Anyone can
defeat it with devtools in one click. Its genuine wins are privacy (the video never leaves the
device) and bandwidth (nothing is uploaded). Authoritative moderation belongs server-side at ingest.

---

## Setup

Requires Node `^20.19` or `>=22.12`.

```bash
npm install     # postinstall vendors the model weights + tfjs WASM binaries into public/
npm run dev     # http://localhost:5173
```

If the postinstall step was skipped or failed (it is deliberately non-fatal), fetch the assets
explicitly:

```bash
npm run models
```

That downloads the NSFWJS MobileNetV2 weights from a **pinned upstream commit**, verifies their size
and SHA-256, and writes a manifest. Nothing is fetched at runtime.

### Verifying the "entirely local" claim

The most convincing check takes ten seconds and does not require reading any code:

1. Load the page and run one scan (this populates the HTTP cache).
2. Open DevTools → Network → set throttling to **Offline**.
3. Scan another video.

It still works, because the weights and the WASM runtime are same-origin static assets and there are
no other network calls in the application at all — no CDN, no fonts, no analytics, no telemetry.

## Usage

**File upload** — drag a video in, or use *Choose file*. Local files take the hardware decode path.

**URL** — paste an `http(s)` URL. The server must send `Access-Control-Allow-Origin`; without it the
browser forbids reading the video's pixels and *no* client-side tool can analyse it. That case is
detected during probing and reported specifically rather than as a generic failure.

Then press **Scan video**. A preliminary verdict appears in roughly two seconds regardless of how
long the video is, and refines from there.

Everything worth tuning is exposed in the UI — policy profile, frame and time budgets, backend,
frame-fit mode, and each optimisation toggle — because a default nobody can turn off is a default
nobody has tested. Turn dedupe off and watch the inference count rise; drop the frame budget and
watch reported coverage fall.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck, then production build to `dist/` (pure static output) |
| `npm run preview` | Serve the production build |
| `npm test` | 171 unit tests over `src/core` — no browser, no GPU, ~0.7 s |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fixtures` | Generate synthetic test clips into `fixtures/` (records in Chromium) |
| `npm run bench` | Build, then drive the real app in a real browser over every fixture and emit the benchmark table |
| `npm run bench:only` etc. | Same as `bench` / `verify` / `matrix` / `mobile` but **skips the rebuild** — use these when you have already built |
| `npm run matrix` | Run across every installed browser engine, plus CPU-throttled and device-descriptor variants |
| `npm run mobile` | Build and serve on the LAN so you can run it on a real phone and capture its numbers |
| `npm run models:violence` | Vendor the opt-in 86.8 MB violence model |
| `npm run eval:violence` | Fitness gate for the violence checkpoint — discrimination + label-order verification |
| `npm run verify` | Assert the claims this README makes — locality, offline operation, clean cancellation, no leaks, specific errors |

The last four are worth highlighting. They are genuine end-to-end tests, not smoke tests: they load
fixtures through the real file input, click the real button, and read the verdict out of the real store.
Between them they found **eleven bugs** that passed typecheck and passed the unit suite — including the
entire model leaking once per scan, and a `flush()` stall that made the "fast" decode path take eight
seconds. All eleven are written up in
[docs/03-tradeoffs-and-alternatives.md](docs/03-tradeoffs-and-alternatives.md#bugs-the-harnesses-found).

`npm run verify` currently reports **13/13 checks passing**, including a full scan completing with the
network offline *and* every request aborted at the routing layer — 0 requests attempted.

**Tested on four browsers spanning all three engine families** — Chrome 150 and Edge 150 (Chromium),
Firefox 153 (Gecko), WebKit 26.5 — plus CPU-throttled runs and Pixel 7 / iPhone 15 device descriptors. That matrix is
where the WebKit crash was found, and it is also where the latency governor is *demonstrated* firing
on a CPU-bound device rather than merely unit-tested. Numbers in
[docs/04-benchmarks.md](docs/04-benchmarks.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/00-runbook.md](docs/00-runbook.md) | Every command in order, and how to reproduce every number quoted |
| [docs/01-architecture.md](docs/01-architecture.md) | Threading model, dataflow, why the pipeline is shaped this way |
| [docs/02-model-selection.md](docs/02-model-selection.md) | Why MobileNetV2, the alternatives rejected and why, the mobile path |
| [docs/03-tradeoffs-and-alternatives.md](docs/03-tradeoffs-and-alternatives.md) | Every significant trade-off, and the bugs the benchmark surfaced |
| [docs/04-benchmarks.md](docs/04-benchmarks.md) | Measured numbers, with device and browser stated |
| [docs/05-limitations-and-production-path.md](docs/05-limitations-and-production-path.md) | Known limits, edge cases, and a realistic route to mobile production |
| [docs/06-mitigation-proposal.md](docs/06-mitigation-proposal.md) | What the browser should do on detection, and the trade-offs |
| [Loom walkthrough](https://www.loom.com/share/f7e8975bb0944337b15629fd68410883) | Screen recording of the reasoning, implementation and trade-offs |

## How it works, in one page

```
File / URL
    │
    ├── local ISO-BMFF file ──► decode.worker: mp4box demux + WebCodecs VideoDecoder
    │                            (hardware decode, free keyframe index)
    │
    └── remote URL / WebM ────► main thread: <video> seek
                                 (HTTP range requests, universal support)
                                        │
                                 ImageBitmap 224×224, transferred
                                        ▼
                            scan.worker: sampler → dedupe → MobileNetV2 → aggregate
                                        │
                                 progress events, ~10 Hz
                                        ▼
                                       UI
```

The central design decision is the sampler. "Decode at 1 fps and classify everything" costs 5,400
inferences on a 90-minute video and tells the user nothing until it finishes. Instead:

- **Phase A — survey.** A *fixed* number of samples spread across the whole timeline. Fixed count
  means constant cost, which means time-to-first-verdict does not grow with duration. Measured at
  **2.0 s for a 12-second clip and 2.5 s for a 3-minute one.**
- **Phase B — refine.** Repeatedly bisect whichever interval is most worth looking at, scored by how
  suspicious its endpoints are and how wide it is. Effort concentrates where there is signal, and
  because it is a priority queue rather than a schedule it can stop at any moment — frame budget,
  time budget, decisive verdict, or cancel — and still give a coherent answer.

On top of that: perceptual dedupe (skip inference on frames identical to one already scored), early
exit on decisive evidence, a latency governor that shrinks the budget on slow or thermally-throttled
devices, and pausing entirely while the tab is hidden.

The verdict is **persistence-gated**, not max-based: either several independent frames clear the
threshold, or one frame is near-certain. And `confidence` is deliberately not `max(frameScore)` —
for a *negative* verdict it is scaled by how much of the timeline was actually inspected, so a
16-frame scan of a two-hour film honestly reports lower confidence in "clean" than a dense scan of a
30-second clip does. See [docs/01-architecture.md](docs/01-architecture.md#verdict-and-confidence).

## Project layout

```
src/
  core/            framework-free engine - no React, no DOM outside frames/
    types.ts config.ts capabilities.ts
    categories.ts  the content taxonomy - what "inappropriate" means, and coverage
    sampler.ts     two-phase adaptive sampling (the interesting part)
    aggregate.ts   verdict + confidence + segments
    governor.ts    latency and resolution feedback
    scorer.ts dhash.ts metrics.ts pipeline.ts
    classifier/    Classifier interface (model-runtime seam) + nsfwjs impl
    detector/      Detector interface (capability seam) + per-category composition
    frames/        FrameSource interface + webcodecs and video-element implementations
  workers/         scan.worker, decode.worker, Comlink protocol, host controller
  app/             React UI (Tailwind v4 + vendored shadcn primitives)
scripts/           model vendoring, fixture generation, benchmark harness
```

`src/core` has no React import and no DOM assumption outside `frames/`. That is the concrete answer
to "how does this become a mobile app": port `FrameSource` and `Classifier` to a native decoder and
Core ML / NNAPI-TFLite, and the sampler, scorer, aggregator and governors move across unchanged.

## Known limitations

The full list is in [docs/05-limitations-and-production-path.md](docs/05-limitations-and-production-path.md).
The four that will bite first:

1. **Sparse sampling has a recall ceiling.** With 16 survey samples over 10 minutes, a 2-second clip
   has roughly a 5% chance of being hit. Phase B refinement and keyframe alignment mitigate this;
   they do not eliminate it.
2. **The model is uncalibrated and out-of-distribution on non-photographic content.** On synthetic
   colour gradients it returns `Porn ≈ 0.53` — confidently mid-range and meaningless. Documented in
   the benchmarks rather than hidden, because it is exactly the kind of behaviour a threshold has to
   be chosen in full knowledge of.
3. **Cross-origin URLs without CORS headers cannot be analysed at all.** Browser security boundary,
   not a fixable bug.
4. **Violence detection is built but disabled, and no audio or text/OCR is screened at all.** The
   violence detector is real and can be switched on in the UI — the point is that doing so makes every
   frame flag, because the only public checkpoint failed
   [its evaluation](docs/02-model-selection.md#violence-detection-a-model-evaluated-and-rejected).
   A shipped-but-off capability is an honest gap, not a hidden one.
