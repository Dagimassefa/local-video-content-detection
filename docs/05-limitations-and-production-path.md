# Limitations, edge cases, and the path to production

## The four that matter most

### 1. Sparse sampling has a hard recall ceiling

With `N` survey samples over duration `D`, content occupying a span of `L` is hit with probability
≈ `min(1, N·L/D)`. For a 10-minute video with 16 survey samples:

| Span | P(hit) in Phase A |
| --- | --- |
| 2 s | **~5%** |
| 10 s | ~27% |
| 30 s | ~80% |
| 60 s | ~100% |

Phase B refinement and keyframe alignment raise this materially — a brief inserted shot usually *has* a
keyframe, since encoders place them at cuts — but they do not eliminate it. **Brief content in a long
video will be missed.** No amount of tuning fixes that; only a denser scan does, and a denser scan is
what the mobile constraint rules out.

This is the strongest argument for server-side scanning at ingest, where the compute budget is different
and every frame can be examined once, forever, per video rather than per view.

### 2. The model is uncalibrated, and out-of-distribution on non-photographic content

Measured, not hypothesised: on abstract synthetic colour gradients the model returns

```
Drawing 0.059 · Hentai 0.037 · Neutral 0.342 · Porn 0.533 · Sexy 0.029
```

`Porn ≈ 0.53` on a test pattern. The distribution is nearly flat with the wrong class marginally ahead —
classic out-of-distribution behaviour from a network trained on photographs and shown something that is
not one. It is not a bug and it is not fixable by thresholding; it is what the model does outside its
training distribution.

The practical consequences: **graphics, animation, screen recordings, UI captures, slide decks and
abstract content are all unreliable**, and mid-range scores from this model carry very little
information. It also means the two "bars" fixtures in [docs/04](04-benchmarks.md) are reported as
`flagged` — those are honest false positives, left in the table rather than quietly excluded.

Separately, the `confidence` figure is a documented heuristic, not a calibrated probability. Its
*qualitative* behaviour is correct and unit-tested (monotone in evidence, monotone in coverage, never
1.0); its absolute values are not claimed to be well-calibrated. Fixing that requires Platt scaling or
isotonic regression on a labelled validation set.

### 3. Cross-origin URLs without CORS headers cannot be analysed at all

If a video's server does not send `Access-Control-Allow-Origin`, the browser forbids reading its pixels.
Not "makes it slow" — forbids. `createImageBitmap` throws `SecurityError` and no client-side code in any
browser can analyse that video.

This is detected during probing (one throwaway 8×8 read) and reported as a specific, actionable error
rather than a generic failure. But it is a browser security boundary, and it means **the URL input path
only works for CORS-enabled hosts** — which excludes most of the web's video.

### 4. Client-side mitigation is bypassable

Devtools defeats any of it in one click. Covered in full in
[docs/06](06-mitigation-proposal.md#honest-limitations-of-client-side-mitigation). The short version:
this is a privacy, bandwidth and UX layer, not enforcement.

---

## Scope: what "inappropriate" is defined to mean

The brief asks whether a video contains "inappropriate visual content" without defining the term. That
is fair in a brief and unworkable in a service, because inappropriateness is not a property of a video —
it is a property of a video *relative to a policy*. A surgical training film, a boxing match and a
Renaissance nude are each inappropriate for exactly one of a children's app, a workplace feed, and
nowhere at all.

So the system does not have an opinion about the word. It screens a declared **taxonomy of categories**
([`core/categories.ts`](../src/core/categories.ts)) and reports which ones it screened:

| Category | Screened | Notes |
| --- | --- | --- |
| **Sexual content** | ✅ **yes** | NSFWJS MobileNetV2, five classes, policy-weighted |
| Violence | ❌ no | Needs a purpose-trained classifier |
| Gore | ❌ no | Colour/texture "blood" heuristics fail on food, sunsets and sport |
| Weapons | ❌ no | Needs context, not object presence — see below |
| Self-harm | ❌ no | Needs a classifier *and* a crisis-response flow; detection without the flow is worse than none |
| Hate imagery | ❌ no | Symbol matching against a curated set — a retrieval problem, not classification |
| Drug use | ❌ no | Needs a purpose-trained classifier |

Two things make this a contract rather than an apology:

1. **Coverage is machine-readable.** Every `ScanResult.stats` carries `screenedCategories` and
   `unscreenedCategories`, and both are shown next to the verdict in the UI. An integrator can
   determine programmatically that a clean result means "no sexual content found" rather than "nothing
   wrong with this video". A narrowing stated only in prose is lost the moment someone codes against
   the JSON.
2. **Adding a category is a registration, not a refactor.** `Detector` implementations contribute
   per-category scores and the pipeline composes them —
   [`combineCategoryScores`](../src/core/detector/Detector.ts) takes the worst category, policies can
   weight categories independently, and 20 unit tests cover the composition including the case that
   matters most: **an absent category reads as unknown, never as clean.**

### Why a second, weaker detector was deliberately not shipped

The quick way to widen coverage is an off-the-shelf object detector. COCO-SSD (`lite_mobilenet_v2`,
~6 MB, runs in tfjs today) has `knife`, `scissors` and `baseball bat` classes, so "weapons" could be
claimed in an afternoon. It was rejected:

- **Object presence is not the signal.** Every cooking video contains a knife. Every barber, every craft
  tutorial. The false-positive rate would make the feature untrustworthy — and once users learn a safety
  control cries wolf they disable it, which is strictly worse than never shipping it.
- **It would corrupt `confidence`.** That number is calibrated (loosely, and documented as such) against
  one detector's behaviour. Mixing in a signal with a very different false-positive profile makes it
  meaningless.
- **It buys a checkbox, not a capability.** The brief asks about reasoning under realistic constraints.
  Claiming coverage that does not survive contact with real video is the wrong answer to that question.

One category screened properly, the rest declared unscreened in the payload, and the architecture makes
a real detector cheap to add. Narrow and honest beats broad and false.

**No audio analysis.** Explicit audio over innocuous video passes completely. Probably the single
highest-value addition per unit of effort.

**No text or OCR.** Slurs, explicit captions, and text overlays are invisible.

**No CSAM handling, deliberately.** This is not a gap to be filled later by the same approach. It requires
hash-matching against controlled databases (PhotoDNA and equivalents), mandatory reporting, and legal
processes that are categorically server-side and institutional. A client-side classifier must not be
presented as addressing it.

**No temporal modelling.** Each frame is classified independently. A model over sequences of frame
embeddings would catch things single frames cannot, and would smooth away isolated false positives.

---

## Known model biases

Inherited from the training data, and they will produce false positives:

- **Skin tone.** NSFW classifiers have a documented history of correlating exposed skin area with
  explicitness, which interacts badly with skin tone and with how much skin different clothing shows.
  Untested here, and it should be an explicit fairness evaluation before any production use.
- **Medical and dermatological content.**
- **Classical art, sculpture, life drawing.**
- **Breastfeeding.**
- **Swimwear, beaches, athletics, gymnastics.**
- **Close-up skin and macro footage** generally.
- **The animation boundary.** `Drawing` versus `Hentai` is a genuinely hard distinction, and stylised
  content sits right on it.

---

## Technical edge cases

| Case | Behaviour |
| --- | --- |
| **HLS / DASH manifests** | Not supported. `<video>` may play them where natively supported, but there is no seekable single file to sample from. |
| **DRM (Widevine / FairPlay)** | Impossible by design. Protected media cannot be read into a canvas — that is the entire point of DRM. |
| **Live streams** | Rejected with a specific error. Sampling requires a known duration; a stream has no end. |
| **`MediaRecorder` WebM** | `duration === Infinity`. Handled via `seekable.end()` and a seek-past-the-end probe — this affects *anything recorded in a browser*, so it is common, not exotic. |
| **Fragmented MP4** | `moov` declares ~0 duration. Handled by deriving duration from the sample table. |
| **Files > 300 MB** | Falls back to `<video>` seeking; mp4box would need the box index for the whole file. |
| **HEVC / AV1** | Depends entirely on platform support. `VideoDecoder.isConfigSupported()` is consulted, and an unsupported codec falls back to `<video>`. |
| **Non-ISO-BMFF (WebM, MKV, AVI)** | `<video>` path. Slower per sample, universally supported. |
| **Zero-keyframe / no sync flags** | First sample is treated as a keyframe so the GOP walk has an anchor. |
| **Rotated video (`matrix` metadata)** | **Not handled.** A phone video shot in portrait with a rotation matrix will be classified in its unrotated orientation. Unlikely to change a verdict much, but it is a real gap and phone video is the target case. |
| **Very short clips (< 1 s)** | Sampling collapses to a single frame; the verdict rests on one observation and confidence reflects that. |
| **Variable frame rate** | Timestamps come from the sample table, so VFR is handled correctly on the WebCodecs path. |
| **iOS Safari memory ceilings** | Untested. iOS is aggressive about killing tabs under memory pressure, and holding a decoder plus a model plus bitmaps is a plausible trigger. |
| **Background tab throttling** | Scanning pauses on `visibilitychange`, so throttling is avoided rather than fought. |

---

## Realistic path to mobile production

Ordered by the ratio of value to effort, as I would actually sequence it.

### Phase 1 — make the existing pipeline production-grade (weeks)

1. **Cascade a small gate model.** A 96–128 px classifier ahead of the 224 px one, escalating only
   borderline frames. Inference cost scales roughly with pixel count, so a 96 px gate is ~4× cheaper, and
   on typical content most frames are confidently neutral. Probably the largest single efficiency win
   available, and it needs no new infrastructure.
2. **Persist the model in OPFS with a versioned manifest.** Every scan after the first becomes a warm
   start. The manifest is already emitted by `fetch-models.mjs`; only the cache layer is missing.
3. **Fit real calibration.** Assemble a labelled validation set, then fit isotonic regression per policy
   profile. This converts `confidence` from a documented heuristic into an actual probability, which is
   what any downstream automated decision needs.
4. **Fairness evaluation across skin tone**, before shipping to anyone. Non-negotiable given the known
   bias class.
5. **Measure on real devices.** The most glaring gap in [docs/04](04-benchmarks.md). A low-end Android
   device and an older iPhone would likely reshape the default budgets, and would test the latency
   governor against real thermal throttling rather than against unit tests.

### Phase 2 — better runtime (weeks)

6. **Migrate to ONNX Runtime Web + int8.** ~4× smaller weights, 2–3× faster on WASM, and an actively
   developed runtime instead of a stalled one. The [`Classifier`](../src/core/classifier/Classifier.ts)
   seam exists precisely for this; it should be one new file.
7. **Adopt WebNN when it ships unflagged.** W3C Candidate Recommendation as of January 2026, still behind
   a flag in Chrome and Edge. It is the shortest route from the web platform to the NPU.
8. **Add the audio signal.** A small audio classifier over the same sampling structure. Highest-value
   coverage gap.

### Phase 3 — native, where the real win is (months)

9. **Core ML on iOS, NNAPI-TFLite on Android**, via React Native or Capacitor, reusing `src/core`
   untouched — only `FrameSource` and `Classifier` need native implementations. An NPU running a MobileNet
   is roughly an order of magnitude more power-efficient than a GPU shader path, which on mobile is the
   difference between a feature people leave on and one they turn off.
10. **Native frame extraction** (`AVAssetImageGenerator`, `MediaMetadataRetriever`) instead of WebCodecs.
11. **Distil a purpose-built model** on accumulated labelled data, at which point the policy boundary is
    yours rather than the model author's, and multi-label output (sexual / violent / self-harm) becomes
    possible in one forward pass.

### Phase 4 — system integration (ongoing)

12. **Scan at ingest, cache by content hash.** Scan once per video instead of once per view. Turns
    client-side scanning into a fast-path optimisation rather than the primary mechanism.
13. **`IntersectionObserver`-driven scanning in feeds**, with a per-video budget and a shared global one, so
    scrolling past fifty videos does not attempt fifty scans.
14. **Server-side authoritative check** on everything that passes the client gate, plus a human review
    queue for the borderline band. Client-side is a filter that reduces load, not a decision-maker.
15. **Remote-config thresholds and shadow mode.** Ship new thresholds in shadow first, compare against the
    current policy on live traffic, and promote only on measured improvement. Threshold changes are product
    changes and deserve the same rigour as a pricing change.
16. **Privacy-preserving telemetry.** Aggregate score distributions and verdict rates, never frames and
    never content. The privacy property is the main reason to do this client-side; instrumenting it away
    would be self-defeating.

---

## Testing gaps I am aware of

- **No detection-accuracy measurement whatsoever.** By design — see
  [`public/samples/README.md`](../public/samples/README.md) — but it means "does it actually catch things"
  is unanswered by this repository.
- **No physical mobile device.** This is the one gap that matters most and is not closed. Four engines
  across all three families *are* covered (`npm run matrix`: Chrome 150, Edge 150, Firefox 153,
  WebKit 26.5), together with CPU throttling, WASM inference, and a phone viewport — which between them
  cover the *engine* and *CPU* dimensions. They do not cover a mobile GPU, a mobile decode block,
  thermal decay, or memory pressure. See [docs/04](04-benchmarks.md#simulated-slow-devices-and-proof-the-governor-works)
  for precisely what each proxy does and does not represent, and `docs/04` again for the one-command
  path to running the harness against a real handset over USB.
- **No WebKit timings.** Playwright's WebKit build ships without media codecs, so it establishes that
  the app loads, detects its capabilities and degrades cleanly there — not how fast it runs. Real Safari
  has codecs; that build does not.
- **The frame sources and the classifier are not unit-tested.** They are thin adapters over browser APIs
  whose behaviour cannot be meaningfully faked; a mock `VideoDecoder` would assert that the mock was
  called. They are covered by the browser-driven harnesses instead, which is how the decoder stall, the
  fragmented-MP4 duration bug and the WebKit `OffscreenCanvas` crash were all found.
- **No sustained-load test.** A five-minute continuous scan is where thermal behaviour matters. The
  latency governor itself is no longer merely asserted — it is
  [observed firing 25 times](04-benchmarks.md#simulated-slow-devices-and-proof-the-governor-works) on a
  CPU-bound run — but thermal decay specifically is untested.
- **No adversarial testing.** Content deliberately crafted to evade a MobileNet classifier — mild
  adversarial perturbation, heavy compression, letterboxing, picture-in-picture insets — would very likely
  defeat this, and none of it has been tried.
