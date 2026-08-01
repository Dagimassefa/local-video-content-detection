# Model selection

## What was chosen

**NSFWJS MobileNetV2**, a transfer-learning classifier on a MobileNetV2 backbone, served as raw
binary weights from the same origin.

| Property | Value |
| --- | --- |
| Weights | **2,619,461 B** (+ 128,945 B topology) = **2.62 MiB** |
| Input | 224 × 224 × 3, normalised to [0, 1] |
| Output | 5-class softmax: `Drawing`, `Hentai`, `Neutral`, `Porn`, `Sexy` |
| Reported accuracy | ~90% (small) / ~93% (mid) per upstream |
| Measured inference | **41–60 ms p50** on WebGPU, Intel Iris Xe (see [benchmarks](04-benchmarks.md)) |
| Licence | Model weights: see [nsfwjs](https://github.com/infinitered/nsfwjs) — permissive |

## Why MobileNetV2, given a mobile target

**The architecture is the one mobile inference is built around.** Depthwise-separable convolutions
with inverted residuals and linear bottlenecks are what MobileNetV2 introduced, and every mobile
inference stack since has optimised for exactly that shape. Core ML, NNAPI, TFLite, XNNPACK, and the
NPU blocks in recent Apple and Qualcomm silicon all have first-class paths for these ops. Choosing a
MobileNet is choosing the architecture with the best-supported route onto a phone's NPU — which
matters far more for the eventual production implementation than a couple of points of benchmark
accuracy.

**2.62 MB is a size a mobile app can actually ship.** It can be bundled into an app binary, cached in
OPFS on the web, or fetched once over a cellular connection without a second thought. Compare the
rejected alternatives below.

**Five classes, not two.** This turns out to matter more than expected. A binary safe/unsafe head
would force the threshold decision into the model, where it cannot be changed. Five classes let the
*policy* decide how much weight suggestive content carries versus explicit content, and how
illustrated content is treated relative to photographic — which is exactly the axis along which a
children's education app and an art community differ. It is what makes
[`POLICIES`](../src/core/config.ts) possible at all.

**It works today.** A ready-to-use browser NSFW classifier with published weights removes the single
largest source of schedule risk in a prototype like this, which is spending the whole budget on model
plumbing instead of on the pipeline design the brief is actually asking about.

---

## The packaging finding

This is the most consequential thing discovered while evaluating the model, and it is not documented
upstream.

The `nsfwjs` npm package ships its weights as **base64 embedded inside JavaScript modules**:

```
node_modules/nsfwjs/dist/models/mobilenet_v2/group1-shard1of1.min.js   3,493,394 B
```

That is 3.5 MB of *JavaScript source* that the engine must parse, base64-decode, and retain in the
module graph. On a mid-range phone that is a multi-hundred-millisecond main-thread stall before a
single frame is classified.

The identical weights exist upstream as raw binary:

```
models/mobilenet_v2/group1-shard1of1    2,619,461 B
models/mobilenet_v2/model.json            128,945 B
```

So [`scripts/fetch-models.mjs`](../scripts/fetch-models.mjs) vendors the raw binary into
`public/models/`, and the app imports from `nsfwjs/core` with a URL so no bundled model definitions
enter the graph at all. The gains:

| | base64-in-JS | raw binary |
| --- | --- | --- |
| Bytes | 3.50 MB | **2.62 MB** (−25%) |
| JS parse cost | 3.5 MB of source | **zero** |
| Cacheable as an asset | no (part of a JS chunk) | **yes** (HTTP + Cache Storage) |
| Loadable lazily | no | **yes** (fetched when a scan starts) |
| Retained in module graph | yes | no |

Pinned to an immutable upstream commit with size and SHA-256 verification, so a silently-changed
upstream file fails loudly rather than quietly degrading detection quality.

---

## Alternatives considered and rejected

| Option | Size | Why not |
| --- | --- | --- |
| **NSFWJS InceptionV3** | ~30 MB (6 shards) | Higher accuracy, but >10× the weights and a much heavier graph. Indefensible against a mobile target; this is the trade the whole brief is about. |
| **NSFWJS MobileNetV2Mid** | ~5.7 MB | ~93% vs ~90%, at 2.2× the size, and it needs `{type: 'graph'}`. A reasonable upgrade *if* accuracy proved limiting; kept as a one-line change rather than the default. |
| **`AdamCodd/vit-base-nsfw-detector`** (ViT-base, transformers.js) | ~86 MB fp32 / ~22 MB int8 | Best accuracy of the candidates. A Vision Transformer is the wrong shape for a phone: attention is far less well served by mobile NPUs than depthwise convolution, and even int8 it is ~8× MobileNetV2. |
| **DINOv3 embeddings + linear probe** | ~87 MB ONNX | Elegant — a frozen backbone plus a trainable head you control, so the policy boundary becomes yours rather than the model author's. Far too heavy for mobile, and it needs labelled data to fit the probe. Noted as a *server-side* option in [docs/05](05-limitations-and-production-path.md). |
| **NudeNet v3 `320n.onnx`** | **12,150,158 B** fp32 | See below — kept as an opt-in extra, not the primary. |
| **Train/distil a custom model** | — | The right long-term answer (see production path) and completely wrong for a prototype whose subject is pipeline design. |

### NudeNet specifically

NudeNet v3 is a YOLOv8-nano **detector**, so it returns labelled bounding boxes for exposed and
covered body regions rather than a whole-frame label. That is genuinely valuable for *targeted* rather
than whole-frame blurring, and it is a better user experience when a detection is partly wrong.

It is not the primary classifier because:

1. **12.15 MB fp32** — 4.6× MobileNetV2. Int8 would bring it to ~3–4 MB, but that is work not yet done.
2. **Detection is the wrong question for the verdict.** The output required is "does this video contain
   inappropriate content", which is whole-frame classification. Localisation is only needed for
   *mitigation*, and only for frames already flagged.
3. **Licence risk.** NudeNet v3's weights derive from Ultralytics YOLOv8, which is **AGPL-3.0**. An
   AGPL model in a commercial product is a legal question, not a technical one, and it needs answering
   before shipping — not after.

So the design keeps it **opt-in, lazily loaded, off by default**, invoked only on already-flagged
frames, behind the `regionDetection` flag and the `Classifier.detectRegions?` optional method. The
core deliverable works without it.

---

## Why TensorFlow.js, despite it being in maintenance mode

This is the least comfortable decision in the project, so it is worth stating plainly.

**TFJS is effectively stalled.** As of July 2026 the published version is still `4.22.0`. Meanwhile
ONNX Runtime Web is at `1.27` and moving quickly: better WebGPU kernels, cleaner int8 quantisation, an
actual WebNN execution provider. On a five-year view ONNX Runtime Web is clearly the better bet.

But the best ready-to-use, mobile-sized NSFW model lives in the TFJS ecosystem, and the choice was
between:

- **Ship on TFJS.** Working detection immediately, on a runtime that is not improving.
- **Port to ONNX.** A better runtime, with the schedule risk of model conversion, quantisation
  validation, and re-verifying accuracy — likely consuming the entire time budget and leaving the
  pipeline design, which is what is actually being assessed, unbuilt.

The resolution is not to pick one but to make the choice cheap to reverse. The
[`Classifier`](../src/core/classifier/Classifier.ts) interface is deliberately narrow:

```ts
interface Classifier {
  init(pref: BackendPref, signal?: AbortSignal): Promise<BackendInfo>;
  classify(bitmap: ImageBitmap): Promise<ClassScores>;   // ImageBitmap in, 5 floats out
  detectRegions?(bitmap: ImageBitmap): Promise<DetectedRegion[]>;
  dispose(): void;
}
```

No tensors, no runtime types, no framework leakage in either direction. Everything TFJS-shaped is
confined to [`classifier/nsfwjs.ts`](../src/core/classifier/nsfwjs.ts). Swapping runtimes means writing
one new file; nothing else in the system needs to know.

That same narrowness is what makes the native mobile port plausible — a Core ML or NNAPI
implementation has exactly this shape too.

## Backend selection

`auto` walks **webgpu → webgl → wasm → cpu**, and every step is a fallback that fires on real devices:
WebGPU adapters fail on blocklisted drivers, WebGL contexts fail in some webviews and under memory
pressure, and WASM is the only thing left that always works.

Crucially, selection is done by *trying*, not by feature detection. `navigator.gpu` exists on machines
where `requestAdapter()` then returns null; `setBackend()` can resolve `true` and the backend still
fail on first use. The only reliable test is to select it and see, and the backend actually resolved —
plus the reason for any fallback — is surfaced in the UI, because it is the single biggest determinant
of every number in the [benchmarks](04-benchmarks.md).

WebGPU is now genuinely broadly available, including **Safari 26 / iOS 26**, so the fast path exists on
the target platform rather than only on desktop.

Two warm-ups happen before any timing is trusted. `nsfwjs.load()` runs one itself on a zero tensor, but
that does not exercise the `fromPixels` upload path, which compiles its own WebGL program on first use.
Without a second warm-up on a real bitmap, the first user-visible frame absorbs that compile and reads
as a 200 ms+ outlier — which would then be reported as our per-frame latency, and would be a lie.

## The path to mobile

The steps, in the order they would actually be taken:

1. **Cascade a smaller gate model.** A 96–128 px classifier in front of the 224 px one, escalating only
   borderline frames. Inference cost scales roughly with pixel count, so a 96 px gate is ~4× cheaper;
   on typical content most frames are confidently neutral and never need the full model.
2. **Migrate to ONNX Runtime Web + int8.** ~4× smaller weights and 2–3× faster on the WASM backend.
   The `Classifier` seam already exists for this.
3. **Persist the model in OPFS with a versioned manifest.** Turns every scan after the first into a warm
   start. The manifest is already emitted by `fetch-models.mjs`.
4. **Adopt WebNN when it ships unflagged.** It reached W3C Candidate Recommendation in January 2026 but
   is still behind a flag in Chrome and Edge, so it is a documented future backend rather than something
   to depend on. When it lands it is the shortest route to the NPU from the web.
5. **Native on-device inference** via React Native or Capacitor: Core ML on iOS, NNAPI-TFLite on
   Android, reusing `src/core` untouched. This is where the real power win is — an NPU running a
   MobileNet is roughly an order of magnitude more efficient per inference than a GPU shader path.
6. **Distil a purpose-built model** against the labelled data a production system accumulates, at which
   point the policy boundary becomes yours rather than the model author's, and calibration
   ([docs/01](01-architecture.md#verdict-and-confidence)) can be fitted properly instead of hand-shaped.

---

## Violence detection: a model evaluated and rejected

Violence screening was requested, so the capability was built and the only publicly available model was
evaluated. **It failed, and the detector ships disabled.** The evaluation is reproducible:

```bash
npm run models:violence     # 86.8 MB, opt-in
npm run eval:violence
```

### What is available

There is no MobileNet-class violence model published anywhere. Every option on Hugging Face is the same
ViT-base fine-tune of `google/vit-base-patch16-224-in21k` on the Kaggle *Real Life Violence Situations*
dataset:

| Variant | Size | vs. NSFW model |
| --- | --- | --- |
| fp32 | 327 MB | 125× |
| fp16 | 164 MB | 63× |
| **int8 / uint8** | **86.8 MB** | **33×** |
| q4f16 | 47.1 MB | 18× |

The model card claims **98.8% test accuracy**.

### What the evaluation found

Two checks, both failed.

**1. It does not discriminate.** Feeding inputs as different as pure black, pure white, saturated red,
saturated green and pure random noise, the logits move a total of **1.26** — probabilities never leave
`[0.27, 0.73]`. A healthy binary classifier swings several logits and saturates near 0 or 1.

**2. The label mapping cannot be confirmed.** The ONNX export carries no `id2label`, so the mapping is
inferred from the dataset's alphabetical class order (`NonViolence`=0, `Violence`=1) — a prior, not
evidence. Verifying it by asymmetry (photographs of people are overwhelmingly non-violent, so the
NonViolence index must dominate) gave a **dead 8/8 split across 16 portraits**, every score between
0.23 and 0.68. The mapping is unverifiable because the model has no opinion to read.

The int8 and q4f16 quantisations behave **identically**, which rules out quantisation damage and places
the fault in the base checkpoint.

### Why 98.8% and noise are consistent

RLVS is a *video* dataset. If frames from the same clip land either side of the train/test split — which
naive frame extraction guarantees — the model can score near-perfectly by recognising clips it has
already seen, while learning nothing that transfers to unseen footage. Near-duplicate leakage is the
most common way a vision benchmark number becomes meaningless, and the symptoms here match it exactly.

### Why enabling it anyway would be worse than shipping nothing

[`combineCategoryScores`](../src/core/detector/Detector.ts) takes the **worst** category, which is
correct: a frame that is violent and non-sexual is exactly as unsafe as one that is sexual and
non-violent. But it means a violence signal idling around 0.65 would push **every frame** over the 0.55
balanced threshold. The scan would flag everything, the NSFW detector's carefully-tuned behaviour would
be buried under noise, and `confidence` — calibrated against one detector — would become meaningless.

A safety control that cries wolf gets switched off, and then nothing is protected.

### What shipped instead

The capability, minus the model:

| | |
| --- | --- |
| [`violenceDetector.ts`](../src/core/detector/violenceDetector.ts) | Full implementation on **ONNX Runtime Web** — a second runtime alongside TFJS, and a second model family (ViT vs MobileNet), composed through the same `Detector` seam |
| [`fetch-models.mjs --violence`](../scripts/fetch-models.mjs) | Opt-in vendoring with size + SHA-256 pinning, plus ORT's WASM binaries served same-origin so the offline guarantee holds |
| [`eval-violence-model.mjs`](../scripts/eval-violence-model.mjs) | The fitness gate any replacement checkpoint must pass |
| `violenceDetection: false` | Default off in `ScanConfig`; the taxonomy reports violence as **not screened** |

Swapping in a better checkpoint is a manifest change plus a passing evaluation. That the architecture
absorbed an entirely different runtime and model family without touching the sampler, the aggregator or
the UI is the strongest available evidence that the capability seam is real.

**The honest summary: violence screening is implemented but not enabled, because the only model I could
obtain does not work, and I would rather ship a documented gap than a feature that flags everything.**
