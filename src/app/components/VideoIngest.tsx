import { FileVideo, Link2, Upload, X } from 'lucide-react';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { formatBytes } from '../lib/utils';
import { useScanStore } from '../store/scanStore';
import { Badge, Button, Card, CardBody, CardHeader, Label } from './ui/primitives';


export function VideoIngest({ disabled }: { disabled: boolean }) {
  const source = useScanStore((s) => s.source);
  const setSource = useScanStore((s) => s.setSource);
  const [urlDraft, setUrlDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFile = useCallback(
    (file: File) => {
    
      if (file.type && !file.type.startsWith('video/')) {
        setHint(`"${file.name}" does not look like a video (${file.type || 'unknown type'}).`);
        return;
      }
      setHint(null);
      setSource({
        kind: 'file',
        label: file.name,
        playbackUrl: URL.createObjectURL(file),
        file,
        bytes: file.size,
      });
    },
    [setSource]
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const file = event.dataTransfer.files?.[0];
      if (file) acceptFile(file);
    },
    [acceptFile, disabled]
  );

  const submitUrl = useCallback(() => {
    const raw = urlDraft.trim();
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      setHint('That is not a valid URL.');
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      setHint('Only http(s) URLs can be loaded.');
      return;
    }
    setHint(null);
    setSource({ kind: 'url', label: parsed.href, playbackUrl: parsed.href });
  }, [setSource, urlDraft]);

  return (
    <Card>
      <CardHeader
        icon={<FileVideo className="h-4 w-4" />}
        title="Input"
        description="Nothing is uploaded. The file is read in-page and every frame is classified on this device."
      />
      <CardBody className="space-y-3">
        {source ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {source.kind === 'file' ? (
                <FileVideo className="h-4 w-4 shrink-0 text-accent" />
              ) : (
                <Link2 className="h-4 w-4 shrink-0 text-accent" />
              )}
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-fg" title={source.label}>
                  {source.label}
                </p>
                <p className="text-[11px] text-muted">
                  {source.kind === 'file'
                    ? `local file${source.bytes ? ` - ${formatBytes(source.bytes)}` : ''}`
                    : 'remote URL - streamed via range requests'}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => setSource(null)}
              aria-label="Remove this video"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!disabled) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={[
                'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors',
                dragging ? 'border-accent bg-accent/8' : 'border-line bg-surface-2/30',
                disabled ? 'pointer-events-none opacity-50' : '',
              ].join(' ')}
            >
              <Upload className="h-5 w-5 text-muted" />
              <p className="text-xs text-fg">Drop a video here</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
              >
                Choose file
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) acceptFile(file);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="video-url">or paste a video URL</Label>
              <div className="flex gap-2">
                <input
                  id="video-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/clip.mp4"
                  value={urlDraft}
                  disabled={disabled}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitUrl();
                  }}
                  className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-muted/60 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
                />
                <Button variant="secondary" size="sm" disabled={disabled} onClick={submitUrl}>
                  Load
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted">
                The URL must send <code className="font-mono">Access-Control-Allow-Origin</code>.
                Without it the browser forbids reading the video&apos;s pixels and no client-side
                tool can analyse it - we detect that case and say so explicitly.
              </p>
            </div>
          </>
        )}

        {hint ? (
          <Badge tone="warn" className="w-full justify-start py-1.5 text-left whitespace-normal">
            {hint}
          </Badge>
        ) : null}
      </CardBody>
    </Card>
  );
}
