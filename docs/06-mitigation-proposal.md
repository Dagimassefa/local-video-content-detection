# Mitigation proposal: what the browser should do on detection

All three strategies below are implemented in
[`ProtectedPlayer.tsx`](../src/app/components/ProtectedPlayer.tsx) behind a live switch, so they can be
compared on the same video rather than argued about in the abstract.

## Recommendation

**Progressive, segment-aware blur with hold-to-reveal, audio muted by default.** Blur the whole video
while the scan is still running, and once flagged spans are known, blur only those and let clean
stretches play normally.

The reasoning is an asymmetry argument. There are two ways to be wrong, and their costs are wildly
different:

- **False negative:** a user sees something they should not have. Serious, and irreversible.
- **False positive:** a user is briefly inconvenienced by a blur they can lift with one gesture.

A ~90%-accurate model on sparsely-sampled frames will be wrong reasonably often in both directions. The
right response is a mitigation whose false-positive cost is *low and recoverable*, so that the threshold
can be set conservatively without making the product unusable. Blur has that shape. Blocking does not.

---

## Why blur specifically

### It is nearly free, technically

```css
.mitigation-blur {
  filter: blur(28px) brightness(0.55) saturate(0.7);
  transform: scale(1.06);   /* hides the transparent edge a large blur radius creates */
  will-change: filter;
}
```

A CSS filter on a wrapper element is applied by the compositor on the GPU during a paint it was already
doing. The video is never decoded to a canvas, never re-encoded, never copied. The marginal cost is
approximately the cost of compositing a layer that was already being composited.

Every alternative is orders of magnitude more expensive for a worse result:

| Approach | Cost | Why not |
| --- | --- | --- |
| **CSS filter** | ~free, GPU | ✅ chosen |
| Canvas pipeline (draw each frame, blur, present) | full-rate decode + JS/WebGL per frame | Competes with inference for the same GPU, drops frames on mobile, and breaks native controls, PiP and captions |
| Re-encode with WebCodecs | encode at playback rate | Absurd for something reversible; also destroys the original |
| Server-side redaction | upload + transcode | Defeats the entire premise — the video would have to leave the device |

`will-change: filter` promotes the layer up front, so the first frame of a flagged span does not pay for
the promotion. Without it there is a visible hitch exactly when it matters most.

### It preserves context and agency

The user can still see that there *is* a video, roughly how long it is, and where in it the problem is.
They can lift the blur deliberately. Compare hiding the element entirely, which communicates only that
something went wrong.

### Segment-aware, not all-or-nothing

Once the scan produces flagged spans, only those spans are blurred. A 40-minute video with one flagged
30-second stretch remains 39.5 minutes of watchable video. Whole-video blocking on the basis of one
detection is the behaviour users experience as broken, and it is what drives them to disable protection
entirely — which is the worst possible outcome for a safety feature.

### Hold-to-reveal, not a toggle

`onPointerDown` reveals, `onPointerUp` re-covers. A toggle can be switched on and forgotten, leaving
protection off for everything that follows. Holding requires continuous intent and self-heals the moment
attention moves. It is also keyboard-accessible (`Enter`/`Space` held) and re-covers on blur.

### Audio is muted

Blurring the picture while explicit audio continues would be a token gesture. Audio is a channel in its
own right, and mitigation mutes by default; the user must opt back in. Worth noting that this system
does not *analyse* audio at all (see [docs/05](05-limitations-and-production-path.md)), so muting is a
blunt instrument — but a blunt correct one is better than a precise omission.

### Blur engages *before* the span starts

Flagged spans are padded by 600 ms each side at aggregation time, and the player engages blur a further
250 ms of pre-roll early. Because sampling is sparse the true scene boundary lies somewhere between two
samples, so that uncertainty is deliberately biased toward covering slightly too much.

The same asymmetry produced a bug fix worth mentioning: `inRestrictedSpan` now **defaults to `true`** and
is corrected downward once evaluated. Both `requestVideoFrameCallback` and `timeupdate` only fire while a
video is playing or seeking, so a video paused at `t=0` inside a flagged span produced no event at all
and the very first frame painted completely unblurred — the single worst moment to be wrong. One frame of
unnecessary blur on a clean stretch is not a comparable error, so the default follows the asymmetry.

---

## The two alternatives, and when they are right

### `block` — pause, replace, require acknowledgement

Playback stops, a placeholder replaces the frame, `src` is dropped, and an explicit action is required to
continue.

**Strengths:** the frames genuinely stop being decoded, so it is meaningfully harder to defeat than a
visual filter. It is also unambiguous — nobody misreads a blocked video as a rendering glitch.

**Weaknesses:** one false positive costs the user the entire video. It feels punitive, and punitive
false positives are what teach users to look for the off switch. It also cannot be segment-aware in any
useful way; pausing every 30 seconds through a long video is worse than blurring.

**When it is right:** a children's product where a false negative is unacceptable and a false positive is
merely annoying to a parent; or content already flagged by a *server-side* system, where confidence is
much higher than a client-side model can justify.

### `pregate` — render nothing until the scan clears

**Strengths:** the only option with genuinely zero exposure risk. Nothing flagged is ever painted, not
even for one frame, because nothing at all is painted until there is a verdict.

**Weaknesses:** the worst perceived latency of the three, and on mobile that is decisive. The user waits
for a cold model load plus a scan for *every* video. Measured on this hardware that is 1.1–2.5 s of model
load plus 0.2–2.4 s of scanning — and 15+ s if the device falls back to WebGL. In a feed it would be
unusable.

**When it is right:** a single-video context where correctness dominates — a moderation review tool, a
first-view gate on user-uploaded content — combined with a warm model. Not a scrolling feed.

---

## Honest limitations of client-side mitigation

**It is advisory, not enforcement.** Anyone can open devtools and delete a class attribute. Any
determined user defeats any of these in seconds. Pretending otherwise would be the most misleading claim
this project could make, so the app states it on screen next to the player rather than in a footnote.

What client-side mitigation is genuinely good for:

1. **Privacy.** The video never leaves the device. For a user checking their own content, or an app that
   does not want to become a processor of other people's media, this is a substantial and real benefit
   that no server-side system can offer.
2. **Bandwidth and cost.** Nothing is uploaded. On mobile that is the user's data allowance.
3. **Latency.** A verdict in under a second, with no round trip.
4. **Protecting users who want protecting.** The threat model for most safety features is not an
   adversary — it is a person who does not want to be shown something unexpectedly. Client-side
   mitigation serves that person completely.

What it cannot do: stop someone determined to see the content. That requires never sending them the
bytes, which means a server-side decision at ingest.

**Production wants both.** Client-side for immediate feedback, privacy and bandwidth; server-side at
ingest for the authoritative decision, with the client-side layer acting as a first gate that reduces how
much reaches the expensive path.

---

## Accessibility

Not an afterthought, because a safety control that is invisible to some users is not a safety control.

- **`aria-live="polite"`** on the verdict, so a screen-reader user is told the result when it lands rather
  than having to go looking. `polite` because the value refines continuously and `assertive` would
  interrupt constantly.
- **`role="alert"`** on the block and pre-gate shrouds, which are genuinely interruptive states.
- **Never colour-only.** Every state carries an icon and text. Red-on-blur would be invisible to a
  significant fraction of users.
- **`prefers-reduced-motion` is respected** globally; the blur transition collapses to effectively
  instant. Some people find a large animated blur genuinely unpleasant.
- **Keyboard parity** for hold-to-reveal.
- **A meaningful blur radius.** A weak blur is worse than none: it obscures the content from nobody while
  making the interface look broken. 28 px plus a brightness reduction at typical player sizes leaves shape
  and colour but not detail.

## What I would add next

1. **Region-targeted blur.** The optional ONNX detector (see
   [docs/02](02-model-selection.md#nudenet-specifically)) returns bounding boxes, so only the relevant part
   of the frame need be obscured. Far better UX when a detection is partly wrong, and it keeps the rest of
   the frame useful. Held back by the AGPL licensing question, not by the engineering.
2. **A "why" affordance.** Showing which class fired and at what score turns an opaque restriction into an
   explicable one, and makes false positives feel like a system limitation rather than an accusation. The
   data is already on the timeline; it is not yet in the player overlay.
3. **Remembered per-user preference**, with a policy floor. Some users legitimately want a lower threshold;
   none should be able to disable protection for a shared or child account.
4. **Audio-aware mitigation** once there is an audio signal, so muting can be targeted rather than blanket.
