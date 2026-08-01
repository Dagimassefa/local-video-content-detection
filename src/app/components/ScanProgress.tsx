import { AlertCircle, Cpu, Loader2 } from 'lucide-react';
import type { ScanErrorKind, ScanPhase } from '../../core/types';
import { formatTimestamp } from '../lib/utils';
import { isScanning, useScanStore } from '../store/scanStore';
import { Badge, Card, CardBody, Meter } from './ui/primitives';

export function ScanProgress() {
  const phase = useScanStore((s) => s.phase);
  const result = useScanStore((s) => s.result);
  const error = useScanStore((s) => s.error);
  const meta = useScanStore((s) => s.meta);
  const config = useScanStore((s) => s.config);
  const decision = useScanStore((s) => s.sourceDecision);

  if (error) {
    return (
      <Card className="border-danger/30">
        <CardBody className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-semibold text-danger">{ERROR_TITLE[error.kind]}</p>
            <p className="text-xs leading-relaxed text-fg">{error.message}</p>
            {ERROR_ADVICE[error.kind] ? (
              <p className="text-[11px] leading-relaxed text-muted">{ERROR_ADVICE[error.kind]}</p>
            ) : null}
          </div>
        </CardBody>
      </Card>
    );
  }

  if (!isScanning(phase) && !result) return null;

  const running = isScanning(phase);
  const sampled = result?.stats.sampledFrames ?? 0;
  const surveyDone = phase === 'refine' || phase === 'done';
  const progress = !running
    ? 1
    : surveyDone
      ? 0.5 + Math.min(1, sampled / Math.max(1, config.budget.maxFrames)) * 0.5
      : Math.min(0.5, (sampled / Math.max(1, config.budget.surveyFrames)) * 0.5);

  return (
    <Card>
      <CardBody className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {running ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            ) : (
              <Cpu className="h-3.5 w-3.5 shrink-0 text-ok" />
            )}
            <p className="truncate text-xs font-medium text-fg">{PHASE_LABEL[phase]}</p>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">
            {sampled} / {config.budget.maxFrames} frames
          </span>
        </div>

        <Meter
          value={progress}
          tone={running ? 'accent' : 'ok'}
          label="scan progress"
          valueText={`${Math.round(progress * 100)} percent`}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {meta ? (
            <Badge>
              {meta.width}x{meta.height} - {formatTimestamp(meta.durationMs)}
            </Badge>
          ) : null}
          {meta?.keyframeTimesMs ? (
            <Badge tone="accent">{meta.keyframeTimesMs.length} keyframes indexed</Badge>
          ) : null}
          {result && result.stats.dedupedFrames > 0 ? (
            <Badge tone="ok">{result.stats.dedupedFrames} frames deduped</Badge>
          ) : null}
          {result && result.stats.failedFrames > 0 ? (
            <Badge tone="warn">{result.stats.failedFrames} frames unreadable</Badge>
          ) : null}
        </div>

        {decision ? (
          <p className="text-[11px] leading-relaxed text-muted">
            <span className="font-medium text-fg">
              {decision.kind === 'webcodecs' ? 'WebCodecs' : 'video element'}:
            </span>{' '}
            {decision.reason}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

const PHASE_LABEL: Record<ScanPhase, string> = {
  idle: 'Idle',
  'loading-model': 'Loading model (2.62 MB, fetched once then cached)',
  probing: 'Reading video metadata and keyframe index',
  survey: 'Phase A - surveying the whole timeline at fixed cost',
  refine: 'Phase B - refining around the most suspicious intervals',
  done: 'Scan complete',
  cancelled: 'Cancelled - verdict reflects frames sampled so far',
  error: 'Failed',
};

const ERROR_TITLE: Record<ScanErrorKind, string> = {
  cors: 'Pixels are not readable (CORS)',
  'unsupported-codec': 'Unsupported container or codec',
  decode: 'Could not decode this video',
  'model-load': 'Model failed to load',
  'no-frames': 'No frames could be read',
  unknown: 'Scan failed',
};

const ERROR_ADVICE: Record<ScanErrorKind, string | null> = {
  cors: 'This is a browser security boundary, not a bug in the detector: without CORS headers no client-side code can read the video\'s pixels. Download the file and upload it instead.',
  'unsupported-codec':
    'Try an MP4 (H.264). HLS/DASH manifests and DRM-protected streams are out of scope for this prototype.',
  decode: 'The file may be truncated or corrupt. A different clip will confirm which.',
  'model-load': 'Run `npm run models` to vendor the weights into public/models/.',
  'no-frames':
    'Every sampled timestamp failed to decode. This usually means an unseekable or damaged file.',
  unknown: null,
};
