import { BookText, ShieldCheck, WifiOff } from 'lucide-react';
import { useRef } from 'react';
import { PerfPanel } from './components/PerfPanel';
import { ProtectedPlayer, type PlayerHandle } from './components/ProtectedPlayer';
import { ScanControls } from './components/ScanControls';
import { ScanProgress } from './components/ScanProgress';
import { TimelineStrip } from './components/TimelineStrip';
import { VerdictCard } from './components/VerdictCard';
import { VideoIngest } from './components/VideoIngest';
import { Badge, Tooltip, TooltipProvider } from './components/ui/primitives';
import { useScanner } from './hooks/useScanner';
import { isScanning, useScanStore } from './store/scanStore';

export function App() {
  const { start, cancel } = useScanner();
  const phase = useScanStore((s) => s.phase);
  const caps = useScanStore((s) => s.capabilities);
  const playerRef = useRef<PlayerHandle>(null);

  const running = isScanning(phase);

  return (
    <TooltipProvider>
      <div className="min-h-dvh">
 
        <header className="z-40 border-b border-line bg-bg/85 backdrop-blur-md sm:sticky sm:top-0">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-5 w-5 text-accent" />
              <div>
                <h1 className="text-sm leading-none font-semibold tracking-tight">
                  Local Video Content Detection
                </h1>
                <p className="mt-1 text-[11px] text-muted">
                  On-device inference - no uploads, no inference API, no server
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
        
              <Tooltip label="Load this page once, then set DevTools > Network to Offline and run a full scan. Everything still works, because the model weights and the WASM runtime are same-origin static assets and there are no other network calls at all.">
                <Badge tone="ok">
                  <WifiOff className="h-3 w-3" />
                  works offline
                </Badge>
              </Tooltip>
              {caps ? <Badge tone="accent">{caps.preferredBackend}</Badge> : null}
              <Tooltip label="Architecture, model selection, trade-offs, benchmarks and the mitigation proposal are all in the docs/ folder.">
                <Badge>
                  <BookText className="h-3 w-3" />
                  see docs/
                </Badge>
              </Tooltip>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-5">
      
          <div className="mb-5 rounded-lg border border-warn/25 bg-warn/8 px-3.5 py-2.5">
            <p className="text-[11px] leading-relaxed text-fg">
              <strong className="font-semibold">Scope:</strong> &quot;inappropriate&quot; is not a
              property of a video - it is a property of a video relative to a policy. So this screens
              a <strong>declared taxonomy</strong> and reports its own coverage: sexual content is
              screened, six other categories are not. Both lists appear with every verdict below and
              ship in the result payload, so a clean verdict provably means &quot;no sexual content
              found&quot; rather than &quot;nothing wrong here&quot;. Adding a category is a{' '}
              <span className="font-mono">Detector</span> registration - see{' '}
              <span className="font-mono">docs/05-limitations-and-production-path.md</span> for the
              taxonomy and for why a weaker second detector was rejected rather than shipped.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="space-y-5">
              <VideoIngest disabled={running} />
              <ScanControls onStart={() => void start()} onCancel={cancel} />
            </div>

            <div className="space-y-5">
              <ScanProgress />
              <VerdictCard />
              <ProtectedPlayer handleRef={playerRef} />
              <TimelineStrip onSeek={(tsMs) => playerRef.current?.seekTo(tsMs)} />
              <PerfPanel />
            </div>
          </div>

          <footer className="mt-8 border-t border-line pt-4 pb-8">
            <p className="text-[11px] leading-relaxed text-muted">
              Prototype for a coding challenge. Detection quality is bounded by a 2.62 MB
              MobileNetV2 classifier and by sparse temporal sampling; both limits are documented
              rather than hidden. Client-side mitigation is advisory - authoritative moderation
              belongs server-side at ingest.
            </p>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}
