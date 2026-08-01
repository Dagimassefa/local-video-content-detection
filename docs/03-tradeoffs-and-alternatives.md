# Trade-offs and alternatives considered

Grouped by decision. Every one of these had a defensible alternative that was not chosen.

---

## 1. Sampling density versus recall

**Chosen:** two-phase adaptive sampling — a fixed-cost survey, then priority-queue refinement under
frame and time budgets.

**Rejected:** uniform sampling at a fixed frame rate.

The honest arithmetic, because this is the most important limitation in the whole system:

With `N` survey samples over a video of length `D`, and inappropriate content occupying a contiguous
span of length `L`, the probability that at least one survey sample lands inside it is approximately
`min(1, N·L/D)`. For a 10-minute video with 16 survey samples:

| Span length | P(hit) in Phase A |
| --- | --- |
| 2 s | **~5%** |
| 10 s | ~27% |
| 30 s | ~80% |
| 60 s | ~100% |

Phase A alone therefore reliably catches sustained content and reliably misses brief content. That is
precisely why Phase B exists, and why samples are snapped onto keyframes — a keyframe is placed at a
scene cut, so a 2-second inserted shot very often *has* a keyframe, which raises the effective hit rate
well above the uniform-sampling figure above. It does not eliminate the problem.

Uniform 1 fps would have `P(hit) ≈ 1` for anything over a second, and would cost 600 inferences on that
same 10-minute video (~30 s of solid GPU work) while telling the user nothing until it finished. On the
stated mobile target that is not a trade worth making. The recall gap is documented rather than hidden,
and the mitigation in production is server-side scanning at ingest, where the compute budget is
different — not a denser client-side scan.

## 2. Keyframe-aligned versus arbitrary timestamps

**Chosen:** snap to keyframes when the container gives us an index.

Free on two axes: a keyframe decodes standalone, and encoders put keyframes at scene changes, so it
carries more information per unit of compute than an arbitrary instant.

**Cost:** temporal precision is bounded by the keyframe interval, and refinement below it returns frames
already scored. Measured on a MediaRecorder MP4 with only 3 sync samples in 12 seconds: 2 distinct
frames and 51% coverage, honestly reported. The fix was to have the source *declare* its temporal
resolution (`VideoMeta.temporalResolutionMs`) so refinement stops below it, rather than wasting budget
discovering the limit repeatedly.

**Alternative:** always walk the GOP to reach an exact timestamp. Rejected as unbounded — a 250-frame
GOP means 250 decodes for one sample, which would make the "fast" path slower than the fallback it
replaced. `MAX_GOP_WALK = 24` bounds it, and past that the keyframe is served with its *real* timestamp
reported.

## 3. WebCodecs versus `<video>` seeking

**Chosen:** both, selected by input type rather than by capability.

The non-obvious part is that WebCodecs is not unconditionally better:

| | WebCodecs | `<video>` seek |
| --- | --- | --- |
| Per-sample cost (measured) | **16–95 ms** | 68–116 ms p50, to 177 ms p95 |
| Keyframe index | **yes, free** | no |
| Off main thread | **yes** | no (DOM-only) |
| Network for a remote file | **entire file** | **range requests only** |
| Container support | ISO-BMFF only | everything the browser plays |

So: hardware decode for local files, streamed seeking for URLs. For a remote video the WebCodecs path
would download hundreds of megabytes to classify 120 frames, because mp4box needs the whole file to
resolve sample offsets. On a metered mobile connection that is the trade that actually matters, and it
inverts the "new API is better" instinct.

**Rejected:** `MediaStreamTrackProcessor` (Chromium-only), and playing at elevated `playbackRate` with
`requestVideoFrameCallback` (no random access, so incompatible with adaptive sampling — it can only go
forwards at whatever rate the pipeline sustains).

## 4. Preprocessing: squash, crop, or multi-crop

**Chosen:** `squash` (direct resize to 224×224) as the default, all three exposed as options.

| Mode | Field of view | Distortion | Cost |
| --- | --- | --- | --- |
| `squash` | **full** | mild aspect stretch | 1× |
| `centerCrop` | **loses ~43% of a 16:9 frame** | none | 1× |
| `multiCrop` | full, undistorted | none | **2×** |

Squash by default because silently discarding 43% of every frame is a worse failure mode than mild
stretching, and CNNs tolerate modest aspect distortion far better than they tolerate the subject being
cropped out. Anything happening at the edges of a wide frame is *invisible* to a centre crop, and framing
routinely puts subjects off to one side.

`multiCrop` is the correct answer for accuracy and is deliberately not the default: doubling inference
cost on every frame to fix a problem that affects a minority of frames is the wrong trade on a phone. It
is reserved for refining frames that already look borderline.

One detail worth noting: when merging multiple crops the code takes the **per-class max, not the mean**.
A crop that misses the content returns a confidently-Neutral distribution, and averaging that against a
confidently-Porn one puts both below threshold — defeating the entire point of evaluating two crops.
There is a unit test asserting exactly this.

## 5. Downscaling and hashing: where the pixels move

**Chosen:** downscale inside `createImageBitmap` via its resize options; compute the perceptual hash from
a **36×32** readback rather than from the 224×224 frame.

`createImageBitmap` resizing uses the browser's own (typically GPU) scaler rather than a canvas
`drawImage` round-trip or a tfjs resize kernel. It also means nsfwjs's internal `resizeBilinear` never
runs, because the tensor already arrives at the model's input size.

The hash readback size is the more interesting number. `getImageData` is the only synchronous GPU→CPU
stall in the hot path. At 224×224 that is 200 KB per frame; at 36×32 it is 4.6 KB — a ~40× reduction.
36×32 is chosen because it divides exactly into dHash's 9×8 comparison grid (4×4 pixel blocks), avoiding
resampling artefacts that would destabilise the hash and silently disable deduplication.

## 6. Perceptual hash choice

**Chosen:** dHash (horizontal gradient hash), 64-bit, Hamming threshold 6.

- **aHash** (mean threshold) is brittle under brightness and contrast changes — so it reports "different"
  for frames that are visually identical, and the dedupe saving evaporates exactly where it matters most,
  since auto-exposure shifts overall brightness constantly between adjacent frames of one shot.
- **pHash** (DCT) is more robust than needed and costs an actual transform.
- **dHash** encodes structure rather than absolute luminance: invariant to exposure and gamma shifts, and
  effectively free. There are unit tests asserting the brightness and contrast invariance, because that
  property *is* the reason for the choice.

Failure mode is deliberately safe: a hash that could not be computed returns all-zeros, which is treated
as "no usable hash" rather than matching everything. Degrades to "classify every frame" — slower, never
wrong.

## 7. Backend: WebGPU / WebGL / WASM / CPU

**Chosen:** try each in order and use the first that actually initialises.

Feature detection is not sufficient. `navigator.gpu` exists on machines where `requestAdapter()` returns
null; `setBackend()` can resolve `true` and the backend still fail on first use. The only reliable test is
selection followed by a real inference.

**Rejected:** requiring WebGPU (excludes too many devices), and pinning WebGL (leaves performance on the
table where WebGPU works, including iOS 26).

Not measured here: WASM and CPU numbers on this machine. `npm run bench -- --backend=wasm` produces them;
they are omitted from [docs/04](04-benchmarks.md) rather than estimated, because reporting a number that
was not measured is worse than reporting none.

## 8. COEP versus cross-origin video

**Chosen:** do not set `Cross-Origin-Embedder-Policy`.

COEP: `require-corp` would unlock `SharedArrayBuffer` and therefore multi-threaded WASM, meaningfully
speeding up the fallback backend. But it forces every cross-origin subresource to opt in via CORP headers,
and arbitrary video URLs do not send them — so enabling it would break URL ingestion entirely.

A faster fallback backend versus supporting half the required input surface. The inputs win. This is the
kind of trade-off that is invisible in a feature list and decisive in practice.

## 9. Where the pipeline runs

**Chosen:** two workers joined by a `MessageChannel`, with the orchestration loop in the scan worker.

**Rejected — one worker:** decode and inference would serialise, making per-sample cost
`decode + inference` instead of `max(decode, inference)`. With measured values that is close to 2×.

**Rejected — orchestration on the main thread:** the sampler's next decision depends on the score that
just came back, so the whole feedback loop would straddle the thread boundary, with a postMessage
round-trip per frame and React renders in between.

**Rejected — frames relayed through the main thread:** simpler to debug, but it puts a transfer per frame
on the UI thread for no benefit. The `MessageChannel` handover is about 20 lines, contained in one module.

## 10. Confidence: calibrated versus heuristic

**Chosen:** a hand-shaped, documented, unit-tested heuristic — and saying so.

Proper calibration means Platt scaling or isotonic regression fitted on a labelled validation set, which
requires exactly the data this repository deliberately does not contain. What *is* claimed is the
qualitative behaviour: monotone in evidence strength, monotone in corroboration, monotone in coverage,
never reaching 1.0. All asserted by tests.

**Rejected:** `confidence = max(frameScore)`. It is the most overconfident statistic available, and it
gives a negative verdict no way to express how little was actually inspected — which for sparse sampling
is the single most important thing the number should convey.

## 11. Testing strategy

**Chosen:** exhaustive unit tests over the pure decision logic, plus **two** real-browser harnesses.
Deliberately **no** mocks for `VideoDecoder`, the GPU backends, or the frame sources.

A mock of `VideoDecoder` would assert that the mock was called. It cannot tell you that reusing a decoder
across a seek stalls `flush()`, that `MediaRecorder` MP4s declare a duration of zero, or that Comlink
strips custom error fields — which are three of the eight things that actually went wrong. Those are
only findable by running real files through a real browser.

Three layers, each catching a different class of problem:

| Layer | What it catches | Cost |
| --- | --- | --- |
| **161 unit tests** over `src/core` | Decision logic: sampling policy, scoring, aggregation, confidence bounds and monotonicity, hashing invariance, governor idempotence, device tiering, category composition | ~0.7 s, no browser |
| **`npm run bench`** — drives the real app over real media | Integration and performance: decoder state, container quirks, backend behaviour, timing | ~1 min |
| **`npm run verify`** — asserts the README's claims | Properties: locality, offline operation, clean cancellation, absence of leaks, error specificity | ~1 min |

The third layer turned out to be the most productive per line of code. It exists because a claim like
"runs entirely locally" is exactly the sort of thing that is true when written and quietly false three
commits later — and three of the eight bugs were found by asserting it rather than believing it.

---

## Bugs the harnesses found

Worth listing explicitly, because it is the strongest argument for having built them at all. Every one
of these passed typecheck, passed the unit suite, and would have shipped. **Eleven bugs**, none of them
findable without running real media through a real browser.

### 1. The latency governor compounded geometrically

The governor mutated the live budget in place on every classified frame. Running once per frame meant a
device measuring 1.66× over target had its budget multiplied by 1.66 *again* on every subsequent frame.
After ten frames `minSampleGapMs` had compounded from 250 ms to roughly 40 seconds and `maxFrames` had
collapsed to its floor — so no interval was wide enough to bisect, refinement never ran, and the scan
reported `stopReason: 'complete'` after only the survey.

The adaptive half of the algorithm was silently dead, **and the stop reason was actively lying about it.**

Fixed by making the governor a pure function of an immutable baseline, so calling it every frame converges
instead of diverging. [`governor.ts`](../src/core/governor.ts), with an idempotence test that calls it 50
times and asserts the result never moves.

### 2. Reusing a `VideoDecoder` across a seek stalled `flush()`

Decode p95 measured **8,069 ms** — exactly the 8-second timeout. `flush()` drains pending work but leaves
reference-frame state behind, and feeding a new keyframe on top of stale state left the decoder waiting for
data belonging to the previous GOP. Fixed with `reset()` + `configure()` when jumping to a different
keyframe, skipped when the walk continues from the same one. Decode p95 dropped to **75–150 ms**.

### 3. Duplicate timestamps counted as corroborating evidence

The sampler never requests the same instant twice, but the *source* returns the frame it actually produced
— and keyframe snapping means two different requests can legitimately resolve to the same frame. Those were
being recorded twice, letting one frame inflate the top-3 mean and masquerade as independent corroboration.
Now deduplicated by actual timestamp: one frame, one vote.

### 4. `timeToFirstVerdictMs` was null exactly when it mattered

It was only set when a *refinement* frame was requested, so any scan that early-exited or completed during
the survey reported `null` — losing the single number that best demonstrates responsiveness, in precisely
the fastest cases.

### 5. `MediaRecorder` output broke both paths

Two distinct bugs from one source of real-world video, neither guessable from the specs:

- **MP4:** fragmented, so `moov` declares ~0 duration. Trusting the header gave 0.14 s for a 12-second
  video. Fixed by deriving duration from the sample table.
- **WebM:** `video.duration === Infinity`, because a live-recorded stream has no known length when its
  header is written. Fixed with `seekable.end()` and a seek-past-the-end probe. This affects *anything
  recorded in a browser*, which is a large share of user-generated video — a functional gap, not a tidy
  edge case.

### 6. The whole model leaked, once per scan

Found by `npm run verify`, which asserts the tfjs tensor count stays flat across five consecutive scans.
It read:

```
267 → 534 → 801 → 1068 → 1335
```

Exactly +267 each time — the model's entire tensor set. The classifier *object* was being reused across
scans, but `init()` was not idempotent, so every scan called `nsfwjs.load()` again and built a second
model while the first was still alive. Nothing ever disposed the old one.

Two costs, one cause: unbounded GPU memory growth in any session that scans more than one video (i.e.
the actual production case), and the full model load paid every single scan — 1.2 s on WebGPU, up to
17 s on WebGL. Fixed by caching the initialisation per requested backend and disposing the previous
model when the backend changes. Repeat scans now report a 0 ms model load, which is honest: that cost
genuinely was not paid.

### 7. Comlink silently stripped the error kind — on the one path that needed it

`ScanError` carries a `kind` (`cors`, `unsupported-codec`, `decode`, …) so the UI can say something
actionable. Comlink marshals a thrown Error by copying `name`, `message` and `stack` and **nothing
else**, so the `kind` and the prototype were both lost crossing the worker boundary.

The cruel part is which path this affected. The `<video>` source lives on the main thread while the
pipeline lives in a worker, so `probe()` *always* crosses — and a CORS-blocked URL, the one error that
is genuinely unfixable and most needs explaining, was reaching the user as "Scan failed / unknown".

First attempt was a Comlink `transferHandler` for `ScanError`. It did not work, because Comlink wraps a
thrown value in an internal `{ value, [throwMarker] }` object and consults handlers against the
*wrapper*, not the error. Rather than reach further into Comlink's internals, the fix makes the error
channel explicit: `probe()` returns `RemoteResult<VideoMeta>` — a success/failure union — and the typed
error is reconstructed on the far side. An explicit contract instead of a dependency on someone else's
exception marshalling.

### 8. Recreating the decode worker per scan broke the offline guarantee

`npm run verify` blocks the network entirely and runs a second scan. It failed: one request was
attempted, and the scan then hung.

The request was the decode worker's own script. `ScanController` constructed a fresh `DecodeWorker()`
for every scan, and constructing a Worker fetches and evaluates its script — a real startup cost per
scan, and a network dependency that invalidated the headline "runs entirely locally" claim on the
second and every subsequent scan. Fixed by keeping the worker alive and adding `release()` to drop just
the file handle and decoder. Now: **0 requests attempted** while offline.

---

## Alternatives at the product level

Worth recording, since they are the questions a reviewer should push on.

**Scan on upload versus scan on playback.** This prototype scans on demand. A feed would want scan-at-ingest
with the result cached against a content hash, plus `IntersectionObserver`-driven scanning as items approach
the viewport, with a per-video budget. The `core/` engine supports both; only the trigger changes.

**Client-side only versus hybrid.** Client-side is a UX and privacy layer: the video never leaves the device
and nothing is uploaded. It is *not* enforcement — devtools defeats it in one click. Production wants both:
client-side for immediate feedback and bandwidth savings, server-side at ingest for the authoritative
decision.

**Frames only versus multi-modal.** Audio, on-screen text (OCR), and temporal structure all carry signal this
system ignores entirely. Audio is probably the highest-value addition per unit of effort — explicit audio over
innocuous video is a real failure mode, and blurring the picture while the audio keeps playing would be a
token gesture. (Mitigation mutes by default for exactly this reason.)

### 9. A correctly CORS-enabled URL was rejected as "no CORS headers"

The worst of the nine, because it broke half the required input surface while looking like correct
behaviour.

`probeReadability` (then `canReadPixels`) wrapped the whole seek → `createImageBitmap` → `getImageData`
sequence in one `try/catch` returning a boolean, and the caller turned `false` into "this video is
served without CORS headers". So *any* failure in that sequence — a slow seek, an unsupported codec,
a missing 2d context — was reported to the user as a server misconfiguration they did not have.

It went unnoticed because the only URL test in the suite was the CORS *failure* case, which passed for
the wrong reason. Verified against a genuinely cross-origin server sending
`Access-Control-Allow-Origin: *` with range support, the app rejected it outright.

Fixed by making the probe report which step failed and treating **only** a `SecurityError` as tainting.
Everything else now reports as `decode` with the underlying detail. `npm run verify` now covers the
success path too: a cross-origin CORS-enabled URL must produce a verdict, must use the streaming source,
and must genuinely infer frames.

The general lesson, and the reason this one is worth writing down: a `catch` that collapses many causes
into one confident message is worse than no message. It had been *reporting* a precise diagnosis it had
not actually made.

### 10. The app was completely broken on WebKit — the engine Safari ships on iOS

Found the moment `npm run matrix` ran a second engine family. WebKit failed with:

```
Can't find variable: OffscreenCanvas
```

`OffscreenCanvas` is absent in that build, and the classifier's warm-up constructed one unguarded. It
threw during `init()`, before a single frame was classified, so the app was **entirely non-functional
on WebKit** while working perfectly in every Chromium browser tested.

That is as serious as it sounds for this brief. WebKit is what Safari runs, **including on iOS**, which
is half the stated production target. Ten browser-driven runs on Chromium had said everything was fine.

Fixed in three places, each with the right degradation for its context:

- **Warm-up** now builds its frame from `ImageData`, which exists in every worker context, instead of
  from a canvas.
- **Main-thread canvas uses** fall back to a detached `<canvas>` element via a shared
  [`createCanvas2D`](../src/core/frames/canvas.ts) helper.
- **Worker-only canvas uses** (thumbnails, perceptual hashing) degrade instead of throwing: no
  thumbnail, and hashing returns an all-zero hash that the dedupe threshold treats as "no usable
  hash". Slower, never wrong.

The general lesson is worth keeping: a feature listed as "widely supported" can still be missing on the
one engine that matters most for your target, and only running there tells you.

### 11. The primary button destroyed keyboard focus on activation

Not caught as a bug report — caught because Playwright could not drive the UI on one engine. The Scan
and Cancel buttons were two different elements swapped by a conditional, so activating Scan unmounted
the element the user had just interacted with.

For a mouse user that is invisible. For a keyboard user it throws focus back to the document body
mid-task, which is a real accessibility failure. Now one button whose label and handler change, so the
node persists across the state transition; the reset button stays mounted and is hidden with
`invisible` rather than unmounted, which also removes a layout shift when a result arrives.

A test harness struggling to interact with a UI is often the harness's problem. Occasionally, as here,
it is the UI telling you something about how it behaves under assistive technology.

---

## 12. Category taxonomy: broad claims versus honest coverage

**Chosen:** screen one category properly, declare the rest unscreened *in the payload*, and make adding a
detector a registration rather than a refactor.

**Rejected:** bolting on an off-the-shelf object detector to claim broader coverage.

The brief asks about "inappropriate visual content" without defining it, and the tempting response is to
widen the claim. COCO-SSD (`lite_mobilenet_v2`, ~6 MB, runs in tfjs today) has `knife`, `scissors` and
`baseball bat` classes, so "weapons detection" was an afternoon's work away.

It was rejected for three reasons, and the reasoning matters more than the conclusion:

- **Object presence is not the signal.** Every cooking video contains a knife; so does every barber and
  most craft tutorials. The false-positive rate would make the feature untrustworthy, and a safety control
  that cries wolf gets switched off — which is strictly worse than never shipping it.
- **It would corrupt `confidence`.** That number is calibrated, loosely and explicitly so, against one
  detector's behaviour. Mixing in a signal with a very different false-positive profile makes it
  meaningless, and the confidence figure is one of the two fields the brief actually asks for.
- **It buys a checkbox, not a capability.**

What was built instead is structural rather than rhetorical:

| | |
| --- | --- |
| `core/categories.ts` | Seven categories declared, one screened, each unscreened one documenting *what it would take* |
| `core/detector/Detector.ts` | Capability seam: detectors contribute per-category scores; `combineCategoryScores` takes the worst |
| `ScanResult.stats` | `screenedCategories` / `unscreenedCategories` — coverage is machine-readable, not prose |
| `VerdictCard` | Both lists rendered next to the verdict, unscreened ones struck through |
| 20 unit tests | Composition, per-category weighting, and the critical property: **absent means unknown, never clean** |

That last property is the one worth defending. If an unscreened category defaulted to `0`, a caller would
reasonably conclude a video had been screened for violence and found clean, when it was never examined.
A gap that is stated in a README is lost the moment someone integrates against the JSON; a gap carried in
the payload cannot be.
