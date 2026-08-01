import { Activity } from 'lucide-react';
import { useMemo } from 'react';
import { activePolicy, useScanStore } from '../store/scanStore';
import { formatTimestamp } from '../lib/utils';
import { Badge, Card, CardBody, CardHeader, Tooltip } from './ui/primitives';
import { dominantClass } from '../../core/scorer';


export function TimelineStrip({ onSeek }: { onSeek?: (tsMs: number) => void }) {
  const result = useScanStore((s) => s.result);
  const meta = useScanStore((s) => s.meta);
  const config = useScanStore((s) => s.config);
  const policy = activePolicy(config);

  const durationMs = meta?.durationMs ?? result?.stats.durationMs ?? 0;

  const marks = useMemo(() => {
    if (!result || durationMs <= 0) return [];
    return result.frames.map((frame) => ({
      ...frame,
      leftPct: Math.min(100, Math.max(0, (frame.tsMs / durationMs) * 100)),
      flagged: frame.score >= policy.frameThreshold,
    }));
  }, [result, durationMs, policy.frameThreshold]);

  const segments = useMemo(() => {
    if (!result || durationMs <= 0) return [];
    return result.segments.map((segment) => ({
      ...segment,
      leftPct: (segment.startMs / durationMs) * 100,
      widthPct: Math.max(0.6, ((segment.endMs - segment.startMs) / durationMs) * 100),
    }));
  }, [result, durationMs]);

  const axis = useMemo(() => {
    if (durationMs <= 0) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, tsMs: durationMs * f }));
  }, [durationMs]);

  return (
    <Card>
      <CardHeader
        icon={<Activity className="h-4 w-4" />}
        title="Timeline"
        description="One mark per sampled frame. Clusters show where adaptive refinement chose to spend its budget."
        actions={
          result ? (
            <div className="flex items-center gap-1.5">
              <Badge tone="danger">{result.segments.length} restricted</Badge>
              <Badge>{result.frames.length} samples</Badge>
            </div>
          ) : null
        }
      />
      <CardBody>
        {!result || durationMs <= 0 ? (
          <p className="py-6 text-center text-xs text-muted">
            The timeline appears once a scan has produced frames.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Score plot. Height is the score; the threshold line makes "flagged" visible. */}
            <div className="relative h-24 w-full overflow-hidden rounded-lg border border-line bg-surface-2/40">
              {segments.map((segment, i) => (
                <div
                  key={`seg-${i}`}
                  className="absolute inset-y-0 bg-danger/15"
                  style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}
                  aria-hidden
                />
              ))}

              <div
                className="absolute inset-x-0 border-t border-dashed border-warn/50"
                style={{ bottom: `${policy.frameThreshold * 100}%` }}
                aria-hidden
              />
              <span
                className="absolute right-1 font-mono text-[10px] text-warn/80"
                style={{ bottom: `calc(${policy.frameThreshold * 100}% + 2px)` }}
                aria-hidden
              >
                threshold {policy.frameThreshold.toFixed(2)}
              </span>

              {marks.map((mark, i) => (
                <Tooltip
                  key={`${mark.tsMs}-${i}`}
                  label={
                    <span className="font-mono text-[11px]">
                      {formatTimestamp(mark.tsMs)} - score {mark.score.toFixed(3)} -{' '}
                      {dominantClass(mark.classes)}
                      {mark.inherited ? ' (inherited: perceptually identical frame)' : ''}
                    </span>
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSeek?.(mark.tsMs)}
                    aria-label={`Seek to ${formatTimestamp(mark.tsMs)}, score ${mark.score.toFixed(2)}`}
                    className={[
                      'absolute bottom-0 w-[3px] -translate-x-1/2 rounded-t-sm transition-opacity hover:opacity-100',
                      mark.flagged ? 'bg-danger' : 'bg-accent/70',
                      // Inherited scores are drawn hollow-ish: they came from dedupe, not from
                      // a forward pass, and conflating the two would overstate how much work
                      // was actually done.
                      mark.inherited ? 'opacity-40' : 'opacity-90',
                    ].join(' ')}
                    style={{
                      left: `${mark.leftPct}%`,
                      height: `${Math.max(4, mark.score * 100)}%`,
                    }}
                  />
                </Tooltip>
              ))}
            </div>

            <div className="relative h-4">
              {axis.map(({ f, tsMs }) => (
                <span
                  key={f}
                  className="absolute font-mono text-[10px] text-muted"
                  style={{
                    left: `${f * 100}%`,
                    transform:
                      f === 0 ? 'none' : f === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {formatTimestamp(tsMs)}
                </span>
              ))}
            </div>

            {result.segments.length > 0 ? (
              <div className="space-y-2 border-t border-line pt-3">
                <p className="text-[11px] font-medium tracking-wide text-muted uppercase">
                  Restricted spans
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {result.segments.map((segment, i) => (
                    <button
                      key={`card-${i}`}
                      type="button"
                      onClick={() => onSeek?.(segment.peakTsMs)}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-danger/25 bg-danger/8 p-1.5 pr-2.5 text-left transition-colors hover:bg-danger/15"
                    >
                      {segment.thumbnail ? (
                        // Blurred in the UI too. There is no reason for a moderation tool to
                        // render the content it just flagged at full clarity.
                        <img
                          src={segment.thumbnail}
                          alt=""
                          aria-hidden
                          className="h-10 w-10 shrink-0 rounded object-cover blur-[6px]"
                        />
                      ) : (
                        <div className="hatch h-10 w-10 shrink-0 rounded" aria-hidden />
                      )}
                      <div>
                        <p className="font-mono text-[11px] text-fg tabular-nums">
                          {formatTimestamp(segment.startMs)} - {formatTimestamp(segment.endMs)}
                        </p>
                        <p className="font-mono text-[10px] text-danger tabular-nums">
                          peak {segment.peakScore.toFixed(2)}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
