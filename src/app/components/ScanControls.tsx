import { Play, RotateCcw, Settings2, Square } from 'lucide-react';
import { POLICIES, type PolicyProfileId, type FitMode } from '../../core/config';
import { isScanning, useScanStore } from '../store/scanStore';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Label,
  RadioCard,
  RadioGroup,
  Separator,
  Switch,
  Tooltip,
} from './ui/primitives';


export function ScanControls({ onStart, onCancel }: { onStart(): void; onCancel(): void }) {
  const config = useScanStore((s) => s.config);
  const phase = useScanStore((s) => s.phase);
  const source = useScanStore((s) => s.source);
  const caps = useScanStore((s) => s.capabilities);
  const result = useScanStore((s) => s.result);

  const setPolicy = useScanStore((s) => s.setPolicy);
  const setFitMode = useScanStore((s) => s.setFitMode);
  const setBackendPref = useScanStore((s) => s.setBackendPref);
  const toggle = useScanStore((s) => s.toggle);
  const setBudget = useScanStore((s) => s.setBudget);
  const reset = useScanStore((s) => s.reset);

  const running = isScanning(phase);

  return (
    <Card>
      <CardHeader
        icon={<Settings2 className="h-4 w-4" />}
        title="Scan configuration"
        description="Thresholds are a product decision, not a model output - so they are named profiles, not magic numbers."
      />
      <CardBody className="space-y-4">
        <div className="flex gap-2">
     
          <Button
            data-testid="primary-action"
            variant={running ? 'danger' : 'default'}
            className="flex-1"
            disabled={!source}
            onClick={running ? onCancel : onStart}
          >
            {running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {running ? 'Cancel scan' : result ? 'Scan again' : 'Scan video'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={reset}
            aria-label="Clear results"
            className={result && !running ? '' : 'invisible pointer-events-none'}
            tabIndex={result && !running ? 0 : -1}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>

        <Separator />

        <fieldset className="space-y-2" disabled={running}>
          <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
            Policy profile
          </legend>
          <RadioGroup
            value={config.policyId}
            onValueChange={(v) => setPolicy(v as PolicyProfileId)}
          >
            {(Object.keys(POLICIES) as PolicyProfileId[]).map((id) => (
              <RadioCard
                key={id}
                id={`policy-${id}`}
                value={id}
                title={POLICIES[id].label}
                description={POLICIES[id].description}
              />
            ))}
          </RadioGroup>
        </fieldset>

        <Separator />

        <fieldset className="space-y-3" disabled={running}>
          <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
            Budgets
          </legend>

          <Slider
            id="survey-frames"
            label="Survey frames"
            help="Phase A sample count. Fixed regardless of video length, which is why time-to-first-verdict does not grow with duration."
            min={4}
            max={40}
            step={2}
            value={config.budget.surveyFrames}
            onChange={(surveyFrames) => setBudget({ surveyFrames })}
          />
          <Slider
            id="max-frames"
            label="Max frames"
            help="Hard ceiling on model invocations across both phases. The single most direct lever on battery cost."
            min={16}
            max={320}
            step={8}
            value={config.budget.maxFrames}
            onChange={(maxFrames) => setBudget({ maxFrames })}
          />
          <Slider
            id="max-wall"
            label="Time budget"
            help="Wall-clock ceiling. Whatever has been sampled when this expires is what the verdict is based on - and coverage reports that honestly."
            min={2}
            max={60}
            step={1}
            value={Math.round(config.budget.maxWallClockMs / 1000)}
            format={(v) => `${v}s`}
            onChange={(seconds) => setBudget({ maxWallClockMs: seconds * 1000 })}
          />
        </fieldset>

        <Separator />

        <fieldset className="space-y-2.5" disabled={running}>
          <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
            Optimisations
          </legend>
          <Toggle
            id="dedupe"
            label="Perceptual dedupe"
            help="Skip inference on frames that are perceptually identical to one already scored. Watch the deduped counter on a static or slideshow video."
            checked={config.dedupe}
            onChange={() => toggle('dedupe')}
          />
          <Toggle
            id="early-exit"
            label="Early exit"
            help="Stop once the evidence is decisive instead of spending the remaining budget confirming it. Directly saves battery on the worst-case content."
            checked={config.earlyExit}
            onChange={() => toggle('earlyExit')}
          />
          <Toggle
            id="pause-hidden"
            label="Pause when tab hidden"
            help="Background scanning is pure battery drain on a screen nobody is looking at."
            checked={config.pauseWhenHidden}
            onChange={() => toggle('pauseWhenHidden')}
          />
        </fieldset>

        <Separator />

        <fieldset className="space-y-2.5" disabled={running}>
          <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
            Detectors
          </legend>
          <div className="flex items-start justify-between gap-3">
            <Label className="leading-snug text-muted">Sexual content (NSFWJS)</Label>
            <Badge tone="ok">always on</Badge>
          </div>
          <Toggle
            id="violence"
            label="Violence (ONNX ViT)"
            help={
              'Turn this on and watch every frame get flagged - that is the point. This checkpoint ' +
              'moves its logits 1.26 between pure black and pure noise, and splits 8/8 on portraits ' +
              'of people. Because the aggregator takes the WORST category, a violence score idling ' +
              'near 0.65 pushes everything over the threshold. Requires npm run models:violence ' +
              '(86.8 MB); without it the scan silently runs NSFW-only. See docs/02.'
            }
            checked={config.violenceDetection}
            onChange={() => toggle('violenceDetection')}
          />
          {config.violenceDetection ? (
            <p className="rounded-md border border-warn/25 bg-warn/8 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
              <strong>Unvalidated.</strong> This checkpoint failed{' '}
              <code className="font-mono">npm run eval:violence</code> and is expected to flag
              essentially every frame. Enabled here to demonstrate exactly why it ships off.
            </p>
          ) : null}
        </fieldset>

        <Separator />

        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={running}>
          <div className="space-y-1.5">
            <Tooltip label="Which tfjs backend to request. 'auto' walks webgpu -> webgl -> wasm -> cpu and reports what actually initialised, because feature detection lies on real devices.">
              <Label htmlFor="backend">Backend</Label>
            </Tooltip>
            <select
              id="backend"
              value={config.backend}
              onChange={(e) => setBackendPref(e.target.value as typeof config.backend)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
            >
              <option value="auto">auto{caps ? ` (${caps.preferredBackend})` : ''}</option>
              <option value="webgpu">webgpu</option>
              <option value="webgl">webgl</option>
              <option value="wasm">wasm</option>
              <option value="cpu">cpu</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Tooltip label="How a non-square frame maps onto the model's square input. 'squash' keeps the full field of view with mild distortion; 'centerCrop' is undistorted but discards ~43% of a 16:9 frame; 'multiCrop' covers the full width at 2x cost.">
              <Label htmlFor="fit">Frame fit</Label>
            </Tooltip>
            <select
              id="fit"
              value={config.fitMode}
              onChange={(e) => setFitMode(e.target.value as FitMode)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
            >
              <option value="squash">squash (full FOV)</option>
              <option value="centerCrop">centerCrop (undistorted)</option>
              <option value="multiCrop">multiCrop (2x cost)</option>
            </select>
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}

function Slider({
  id,
  label,
  help,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  id: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
  format?: (value: number) => string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Tooltip label={help}>
          <Label htmlFor={id}>{label}</Label>
        </Tooltip>
        <span className="font-mono text-[11px] text-muted tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-accent disabled:opacity-50"
      />
    </div>
  );
}

function Toggle({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange(): void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <Tooltip label={help}>
        <Label htmlFor={id} className="cursor-pointer leading-snug">
          {label}
        </Label>
      </Tooltip>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
