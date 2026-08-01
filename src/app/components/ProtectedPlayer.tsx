import { Eye, EyeOff, Lock, Pause, Play, ShieldAlert, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Segment } from '../../core/types';
import { formatTimestamp } from '../lib/utils';
import { useScanStore, type MitigationPolicy } from '../store/scanStore';
import { Badge, Button, Card, CardBody, CardHeader, Tooltip } from './ui/primitives';



export interface PlayerHandle {
  seekTo(tsMs: number): void;
}


const PRE_ROLL_MS = 250;

const SEGMENT_TRUST_COVERAGE = 0.9;

export function ProtectedPlayer({ handleRef }: { handleRef?: Ref<PlayerHandle> }) {
  const source = useScanStore((s) => s.source);
  const result = useScanStore((s) => s.result);
  const phase = useScanStore((s) => s.phase);
  const mitigation = useScanStore((s) => s.mitigation);
  const setMitigation = useScanStore((s) => s.setMitigation);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const [inRestrictedSpan, setInRestrictedSpan] = useState(true);
  const [currentMs, setCurrentMs] = useState(0);

  const flagged = result?.verdict.contains_inappropriate_content === true;
  const segments = result?.segments ?? [];
  const scanFinished = result?.finalized === true;

  useEffect(() => {
    setAcknowledged(false);
    setRevealing(false);
    setPlaying(false);
    setCurrentMs(0);
    setInRestrictedSpan(true);
  }, [source?.playbackUrl]);

  useImperativeHandle(handleRef, () => ({
    seekTo(tsMs: number) {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = tsMs / 1000;
      setCurrentMs(tsMs);
    },
  }));


  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let rvfcHandle = 0;

    const evaluate = () => {
      const nowMs = video.currentTime * 1000;
      setCurrentMs(nowMs);
      setInRestrictedSpan(isInsideSpan(nowMs, segments, PRE_ROLL_MS));
    };

    evaluate();

    video.addEventListener('loadeddata', evaluate);

    const supportsRvfc = typeof video.requestVideoFrameCallback === 'function';

    if (supportsRvfc) {
      const tick = () => {
        if (cancelled) return;
        evaluate();
        rvfcHandle = video.requestVideoFrameCallback(tick);
      };
      rvfcHandle = video.requestVideoFrameCallback(tick);
    } else {
      video.addEventListener('timeupdate', evaluate);
      video.addEventListener('seeked', evaluate);
    }

    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', evaluate);
      if (supportsRvfc && rvfcHandle) {
        video.cancelVideoFrameCallback(rvfcHandle);
      } else {
        video.removeEventListener('timeupdate', evaluate);
        video.removeEventListener('seeked', evaluate);
      }
    };
  }, [segments, source?.playbackUrl]);


  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const shouldHardStop =
      (mitigation === 'block' && flagged && !acknowledged) ||
      (mitigation === 'pregate' && !scanFinished);
    if (shouldHardStop && !video.paused) {
      video.pause();
      setPlaying(false);
    }
  }, [mitigation, flagged, acknowledged, scanFinished]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(
        () => setPlaying(true),
        () => setPlaying(false)
      );
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  const pregateActive = mitigation === 'pregate' && !scanFinished && phase !== 'idle';
  const blockActive = mitigation === 'block' && flagged && !acknowledged;
 
  const coverage = result?.stats.coverage ?? 0;
  const segmentsTrustworthy =
    scanFinished && segments.length > 0 && coverage >= SEGMENT_TRUST_COVERAGE;

  const blurActive =
    mitigation === 'blur' &&
    flagged &&
    !revealing &&
    (!segmentsTrustworthy || inRestrictedSpan);

  const obscured = pregateActive || blockActive || blurActive;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ShieldAlert className="h-4 w-4" />}
        title="Player &amp; mitigation"
        description="Switch strategies to compare them on the same video."
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {(['blur', 'block', 'pregate', 'off'] as MitigationPolicy[]).map((policy) => (
              <Tooltip key={policy} label={POLICY_HELP[policy]}>
                <Button
                  variant={mitigation === policy ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setMitigation(policy)}
                  aria-pressed={mitigation === policy}
                >
                  {POLICY_LABEL[policy]}
                </Button>
              </Tooltip>
            ))}
          </div>
        }
      />

      <div className="relative aspect-video w-full bg-black">
        {source ? (
          <>
            <div className={obscured ? 'mitigation-blur h-full w-full' : 'mitigation-blur-off h-full w-full'}>
              <video
                ref={videoRef}
                src={source.playbackUrl}
              
                muted={muted || obscured}
                playsInline
                preload="metadata"
                crossOrigin={source.kind === 'url' ? 'anonymous' : undefined}
                className="h-full w-full object-contain"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
            </div>

            {pregateActive ? (
              <Shroud
                icon={<Lock className="h-5 w-5" />}
                title="Held until the scan clears"
                body="Nothing is displayed until a verdict exists. Zero exposure risk, at the cost of the worst perceived latency of the three - which is exactly the trade-off worth arguing about."
              />
            ) : null}

            {blockActive ? (
              <Shroud
                icon={<EyeOff className="h-5 w-5" />}
                title="Video blocked"
                body={`Flagged with confidence ${result?.verdict.confidence.toFixed(2)}. Playback is stopped rather than obscured. Least bypassable, and harshest when the detection is wrong.`}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setAcknowledged(true)}>
                    I understand - show anyway
                  </Button>
                }
              />
            ) : null}

            {blurActive ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Badge tone="danger" className="py-1">
                  <ShieldAlert className="h-3 w-3" />
                  sensitive content - confidence {result?.verdict.confidence.toFixed(2)}
                </Badge>
                <p className="max-w-sm text-xs leading-relaxed text-white/85">
                  {!scanFinished
                    ? 'Blurred while the scan is still running.'
                    : segmentsTrustworthy
                      ? `This span (${formatTimestamp(currentMs)}) was flagged. Clean stretches play unobscured.`
                      : `Whole video blurred: only ${Math.round(coverage * 100)}% of the timeline was sampled, so the gaps between the ${segments.length} flagged span${segments.length === 1 ? '' : 's'} are unexamined rather than known-clean.`}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onPointerDown={() => setRevealing(true)}
                  onPointerUp={() => setRevealing(false)}
                  onPointerLeave={() => setRevealing(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setRevealing(true);
                  }}
                  onKeyUp={() => setRevealing(false)}
                  onBlur={() => setRevealing(false)}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Hold to reveal
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="hatch flex h-full w-full items-center justify-center">
            <p className="text-xs text-muted">Load a video to preview mitigation.</p>
          </div>
        )}
      </div>

      <CardBody className="flex flex-wrap items-center justify-between gap-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="icon"
            onClick={togglePlay}
            disabled={!source || pregateActive || blockActive}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMuted((m) => !m)}
            disabled={!source || obscured}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted || obscured ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <span className="ml-1 font-mono text-[11px] text-muted tabular-nums">
            {formatTimestamp(currentMs)}
          </span>
        </div>

        <p className="max-w-md text-[11px] leading-relaxed text-muted">
          Client-side mitigation is <strong className="text-fg">advisory, not enforcement</strong>
          &nbsp;- anyone can defeat it with devtools. Its real wins are privacy (the video never
          leaves the device) and bandwidth (nothing is uploaded). Authoritative moderation
          belongs at ingest.
        </p>
      </CardBody>
    </Card>
  );
}

function Shroud({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="hatch absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/80 p-6 text-center"
    >
      <span className="text-white/80">{icon}</span>
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-white/70">{body}</p>
      {action}
    </div>
  );
}

function isInsideSpan(tsMs: number, segments: readonly Segment[], preRollMs: number): boolean {
  for (const segment of segments) {
    if (tsMs >= segment.startMs - preRollMs && tsMs <= segment.endMs) return true;
  }
  return false;
}

const POLICY_LABEL: Record<MitigationPolicy, string> = {
  blur: 'Blur',
  block: 'Block',
  pregate: 'Pre-gate',
  off: 'Off',
};

const POLICY_HELP: Record<MitigationPolicy, string> = {
  blur: 'Recommended default. GPU-composited CSS blur, audio muted, hold-to-reveal, and once spans are known only the flagged ones stay covered. Cheap, reversible, and preserves context - but bypassable.',
  block: 'Strictest. Playback stops and a placeholder replaces the frame; explicit consent is required to continue. Least bypassable, and a single false positive costs the user the whole video.',
  pregate: 'Nothing renders until the scan clears. Zero exposure risk, worst perceived latency - the user waits on a cold start plus a scan for every video, which is the worst of the three on mobile.',
  off: 'No mitigation. For comparison, and for seeing what the detector was reacting to.',
};
