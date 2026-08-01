# Architecture

## The constraint that shapes everything

The brief says the production target is mobile, with limited compute, memory, battery and device
variability. That single sentence rules out the obvious implementation before any code is written.

The obvious implementation is: decode at some frame rate, classify every frame, report at the end.
It is wrong here in three separate ways.

1. **Cost is linear in duration.** A 90-minute video at 1 fps is 5,400 inferences. At a measured
   ~48 ms per inference that is over four minutes of sustained GPU load — thermal throttling,
   measurable battery, and on a phone the OS will start killing things.
2. **The user learns nothing until it finishes.** Time-to-answer scales with the input, which is
   precisely the property an interface must not have.
3. **Effort is spread uniformly** over a signal that is not uniform. The interesting parts of a video
   are almost never evenly distributed.

So the architecture is organised around a different idea: an **anytime algorithm** that always has a
current best answer and improves it until something tells it to stop.

---

## Threading model

```
┌──────────────────── MAIN THREAD (React) — stays interactive ─────────────────────┐
│  Ingest · ScanControls · ScanProgress · VerdictCard                             │
│  ProtectedPlayer (mitigation) · TimelineStrip · PerfPanel                        │
│                                                                                  │
│  zustand store; worker events coalesced and flushed once per animation frame     │
│  VideoElementFrameSource lives here — a <video> cannot exist in a worker         │
└────────────┬─────────────────────────────────────────────────┬──────────────────┘
             │ Comlink RPC (control only)                      │ Comlink RPC
┌────────────▼──────────────────┐   MessageChannel     ┌───────▼─────────────────┐
│ decode.worker.ts              │   ImageBitmap        │ scan.worker.ts          │
│  mp4box.js demux              │  ═══════════════►    │  sampler + pipeline     │
│  WebCodecs VideoDecoder       │  (transferred,       │  tfjs: webgpu→webgl→    │
│  createImageBitmap → 224²     │   zero-copy,         │        wasm→cpu         │
│  dHash on a 36×32 readback    │   never via main)    │  nsfwjs MobileNetV2     │
│  decodeQueueSize backpressure │                      │  aggregate → events     │
└───────────────────────────────┘                      └─────────────────────────┘
```

### Why two workers, joined by a direct `MessageChannel`

**Pipelining.** Decode and inference overlap: frame N+1 is being demuxed and decoded while frame N is
in the model. Cost per sample is `max(decode, inference)` rather than `decode + inference`. With
measured decode at ~16–95 ms and inference at ~48 ms, that is close to a 2× throughput difference.

**The main thread never sees a frame.** `scan.worker` and `decode.worker` are joined by a
`MessageChannel` handed over at startup, so an `ImageBitmap` goes worker → worker as a transferable.
The UI thread does *no* per-frame work at all on the hardware path.

That claim is measured, not asserted. `PerformanceObserver('longtask')` counts tasks that blocked the
main thread for over 50 ms, and it is displayed live in the perf panel. During a scan it stays at or
near zero. If the pipeline were on the main thread it would be in the hundreds.

### Why the fallback source is on the main thread anyway

A `<video>` element is a DOM object and cannot be constructed in a worker. So the seek-based source
lives on the main thread and is the single exception: one `ImageBitmap` transfer per sample. At
sparse sampling rates that is a handful of transfers per second of microsecond-scale work — visible
in the long-task counter as nothing.

### `scan.worker` owns the pipeline, not the main thread

The sampler's next decision depends on the score of the frame that just came back. Putting the
orchestration loop next to the classifier keeps that entire feedback cycle — decide, decode,
classify, aggregate, decide again — off the UI thread. React's only job is to render what arrives.

It also means the frame source is *always* remote from the pipeline's point of view: a
[`RemoteFrameSource`](../src/workers/protocol.ts) on a `MessagePort`. Whether the other end is a
hardware decoder in a sibling worker or a `<video>` element on the main thread, the pipeline code is
identical. There is no branch anywhere in the orchestrator for "which source am I using".

---

## `src/core` is framework-free on purpose

No React import. No DOM assumption outside `core/frames/`. This is the concrete answer to "how would
this become a mobile app", and it is a structural property rather than an intention:

| Layer | Web today | Native mobile |
| --- | --- | --- |
| `FrameSource` | WebCodecs / `<video>` | `AVAssetImageGenerator` / `MediaMetadataRetriever` |
| `Classifier` | tfjs + nsfwjs | Core ML / NNAPI-TFLite |
| `Detector` | wraps the classifier per category | same, unchanged |
| **sampler, scorer, aggregate, governor, dhash, metrics, categories** | **unchanged** | **unchanged** |

### Two seams, not one

`Classifier` and `Detector` are separate boundaries because they answer different questions:

- **`Classifier`** is a *model runtime* seam — "run this network, give me its outputs". It exists so
  TensorFlow.js can be replaced by ONNX Runtime Web without anything else changing.
- **`Detector`** is a *capability* seam — "screen this frame for these categories". It exists so a new
  content category is a registration rather than a refactor: the pipeline runs every registered detector
  over the same bitmap and [`combineCategoryScores`](../src/core/detector/Detector.ts) collapses their
  per-category output into the single frame score the sampler and aggregator already work with.

That collapse takes the **worst** category, not the sum or the mean — a frame that is confidently violent
and confidently non-sexual is exactly as unsafe as one that is confidently sexual. Summing would let two
mild unrelated signals manufacture a strong one; averaging would let a clean category dilute a real
detection. And a category that was never screened contributes nothing in either direction: absent means
*unknown*, never *clean*. See [`core/categories.ts`](../src/core/categories.ts) for the taxonomy, and
[docs/05](05-limitations-and-production-path.md#scope-what-inappropriate-is-defined-to-mean) for what is
and is not screened.

The interesting half — the sampling policy, the verdict logic, the confidence calibration, the budget
feedback — is the half that ports for free. Both interfaces are deliberately narrow:
`Classifier.classify()` takes an `ImageBitmap` and returns five numbers. No tensors, no runtime
types, no framework leakage.

---

## Frame acquisition: the non-obvious decision

WebCodecs is **not** unconditionally better than `<video>`, and the reason is bandwidth rather than
compute.

- **Uploaded file** → WebCodecs. The bytes are already on the device. Demuxing costs nothing extra
  and buys hardware decode, no seek latency, and the keyframe index.
- **Remote URL** → `<video>`. mp4box needs the whole file to resolve sample offsets, so the WebCodecs
  path would download *the entire video* to classify 120 frames. A `<video>` element issues HTTP range
  requests and fetches only the neighbourhoods it seeks to. Slower per frame, dramatically less
  network — and on a metered mobile connection that is the trade that actually matters.

Also `<video>` for WebM/MKV (not ISO-BMFF), for files over 300 MB (mp4box would hold the box index
for the whole thing), and wherever WebCodecs is missing. The chosen path and the *reason* are shown
in the UI, because a reviewer should not have to guess which code ran.

### The keyframe index changes the algorithm, not just the speed

`getTrackSamplesInfo()` returns the whole sample table — byte offsets, timestamps, sync flags —
without decoding anything. Keyframes are therefore free to identify, and they are doubly valuable:
they decode standalone (no dependent frames to walk), and encoders place them at scene changes, so
they carry more information per unit of compute than an arbitrary instant. The sampler snaps its
choices onto them.

Two implementation details that came from real files rather than from the spec:

- **Sample bytes are read from the `Blob`, not from mp4box.** mp4box is constructed with
  `keepMdatData = false`, so it parses structure and discards payloads; the bytes for each sample are
  sliced straight out of the `Blob`, which the browser keeps backed by the file on disk. Scanning a
  300 MB video therefore holds the box index in memory and essentially nothing else.
- **Duration comes from the sample table, not the header.** Anything produced by `MediaRecorder` —
  i.e. anything recorded in a browser — is a *fragmented* MP4 whose `moov` declares a duration of
  roughly zero. Trusting it yields 0.14 s for a 12-second video and every subsequent sample lands out
  of range.

---

## The sampler

[`src/core/sampler.ts`](../src/core/sampler.ts). Pure, deterministic, no clock and no I/O — which is
why the sampling *policy* is unit-testable without a browser, a GPU, or a video file.

### Phase A — survey

A fixed `surveyFrames` (default 16) samples at cell **centres** across the timeline, snapped onto
nearby keyframes.

Cell centres rather than edges because the first and last frames of a video are the least informative
frames it has — fades from black, title cards, credits — and sampling at `t=0` reliably wastes one of
the most expensive operations in the system on a black frame.

Fixed count is the whole point: cost is independent of duration, so **time-to-first-verdict does not
grow with the input.** Measured: 2.0 s for a 12-second clip, 2.5 s for a 3-minute one.

### Phase B — refine

A max-priority queue over intervals:

```
priority = (0.15 + max(scoreLeft, scoreRight)) × log₂(1 + width / minSampleGap)
```

Three deliberate choices in that expression:

- **`max` of the endpoints, not the mean.** An interval bounded by one clean and one flagged frame is
  exactly where a scene boundary lies. Averaging would rank it below a pair of mildly suspicious
  frames that tell us less.
- **`log₂` of the width, not the width.** Linear width lets one enormous gap dominate the queue
  forever — halving it produces two still-enormous gaps — starving genuinely suspicious narrow
  intervals. Log keeps width a meaningful tiebreak without letting it overwhelm the signal.
- **The `0.15` baseline.** Without it, a video whose survey came back entirely clean has priority zero
  everywhere and refinement has no basis to choose. With it, priority degrades gracefully into
  "bisect the biggest hole", which is the correct behaviour in the absence of any signal.

### Cost controls

| Control | Mechanism |
| --- | --- |
| **Perceptual dedupe** | 64-bit dHash; within Hamming distance 6 of a recently-scored frame, inherit its score and skip inference entirely. Measured: 19/50 samples on one fixture, 108/160 before other fixes. |
| **Early exit** | Stop once evidence is decisive — a saturated single frame, or corroborated frames comfortably over threshold. Never fires on a *negative* verdict, since absence of evidence is exactly the case needing more sampling. |
| **Latency governor** | Compare measured p50 inference against target; shrink the frame budget and coarsen the refinement floor if over. This is the thermal-throttling defence. |
| **Resolution feedback** | Duplicate frames are measured evidence that we are asking for finer detail than the source can resolve; the refinement floor backs off multiplicatively. |
| **Hidden-tab pause** | `visibilitychange` gates the loop. Background scanning is pure battery drain on a screen nobody is looking at. |
| **Device tiering** | `hardwareConcurrency`, `deviceMemory`, `connection.saveData` and the resolved backend pick the starting budget. A weak device gets a smaller, faster scan rather than the same work stretched over a jankier ten seconds. |

Both governors are **pure functions of an immutable baseline**, which is not a stylistic preference —
see [`docs/03`](03-tradeoffs-and-alternatives.md#bugs-the-harnesses-found) for the bug that made it
necessary.

---

## Verdict and confidence

[`src/core/aggregate.ts`](../src/core/aggregate.ts). Producing a per-frame score is a library call;
deciding what a sparse, unevenly-spaced, partially deduplicated sequence of frame scores implies
about a whole video is the actual engineering.

### Per-frame score

```
frameScore = Σ P(class) × policyWeight(class)
```

Because the class probabilities are a softmax (they sum to 1) and every weight is ≤ 1, the result is
bounded by 1 by construction — no rescaling, and the number keeps a readable meaning: *probability
mass sitting on classes this policy cares about*.

Weights are named, documented **policy profiles** (`strict` / `balanced` / `permissive`) rather than
constants sprinkled through the pipeline. Where the line falls between "fine" and "restricted" is a
product decision that differs enormously between a children's education app and an art community, and
structuring it this way is also what makes it remotely configurable in production.

### The verdict is persistence-gated

```
positive  ⟺  (independentFlaggedFrames ≥ minFlaggedFrames)  OR  (maxScore ≥ singleFrameThreshold)
```

Both routes are needed. Persistence alone misses a brief but unmistakable shot; a single-frame rule
alone lets one false positive condemn an entire video. And "independent" is enforced: two flagged
frames closer together than `independenceGapMs` are one observation sampled twice, not two
observations, so they collapse to one.

### Confidence is deliberately not `max(frameScore)`

The max of a noisy per-frame signal is the most overconfident statistic available — one unlucky frame
of skin-toned background reads 0.97 and gets reported as near-certainty. It also gives a *negative*
verdict no way at all to express "I only looked at 16 frames of a two-hour film".

**Positive verdict:**

```
strength    = (topKMean − frameThreshold) / (1 − frameThreshold)     // normalised, k = 3
persistence = independentFlagged / minFlaggedFrames                  // clamped to 1
confidence  = 0.5 + 0.5 × (0.7·strength + 0.3·persistence)           // capped at 0.99
```

Both terms are required: sustained mid-confidence detections and one blazing frame are different
epistemic situations, and a single number should not conflate them.

**Negative verdict:**

```
margin     = 1 − min(1, maxScore / frameThreshold)
coverage   = Σ min(2 s, half-distance to each neighbour) / duration      // ∈ [0,1]
confidence = 0.5 + 0.5 × margin × (0.4 + 0.6 × coverage)                // capped at 0.99
```

`coverage` is the honest term. Each sample vouches for roughly two seconds either side of itself,
bounded by its neighbours, so 16 samples fully cover a 30-second clip and barely scratch a two-hour
film. It scales achievable confidence between **0.70** (looked at almost nothing, found nothing) and
**0.99** (looked everywhere, found nothing) rather than collapsing to 0.5 — finding no evidence in a
handful of well-spread samples is weak evidence of absence, but it is not *no* evidence.

**This is a documented heuristic, not a calibrated probability.** Doing it properly means fitting
Platt scaling or isotonic regression on a labelled validation set, which requires exactly the data
this repository deliberately does not contain. The shape of the function encodes the right
*qualitative* behaviour — monotone in evidence, monotone in coverage, never claiming certainty — and
all of that is unit-tested. The absolute values are not claimed to be well-calibrated.

### Segments

Flagged samples within 2 s of each other merge into one restricted span, padded by 600 ms each side.
The padding is asymmetric in intent: because sampling is sparse, a scene's true boundary lies
somewhere between two samples, and biasing that uncertainty toward restricting slightly too much is
the only defensible direction for a safety feature.

---

## Event flow and UI

The pipeline emits progress at ~10 Hz. Those events are then **batched again** on the main thread and
flushed once per animation frame, keeping only the last result in each batch since each supersedes the
previous.

Without that, the worker would trigger a React render per frame and reintroduce the exact main-thread
pressure the workers exist to avoid — a self-inflicted version of the problem. Terminal events
(`done`, `error`) bypass the batch, because a final verdict should not wait a frame, and because
`requestAnimationFrame` never fires in a hidden tab.

## Build and bundle

Vite 8, static output, no server runtime — which makes "no server-side processing" a structural fact
rather than a promise.

The ML runtime is dynamically imported when a scan starts, so a visitor who never scans anything never
downloads it:

| | gzip |
| --- | --- |
| Eager (app + React + Radix + Tailwind) | **115 KB JS + 8 KB CSS** |
| Lazy (tfjs + nsfwjs + mp4box + workers) | **460 KB** |
| Model weights (fetched on first scan, then cached) | 2.62 MB raw binary |
| tfjs WASM binaries (only if WebGL is unavailable) | 1.1 MB |

One deliberate omission: **`Cross-Origin-Embedder-Policy` is not set.** COEP would unlock
SharedArrayBuffer and multi-threaded WASM, meaningfully speeding up the CPU fallback — but it also
forces every cross-origin subresource to opt in via CORP headers, and arbitrary video URLs do not send
those. Enabling it would break URL ingestion, which is half the required input surface. The inputs
win.
