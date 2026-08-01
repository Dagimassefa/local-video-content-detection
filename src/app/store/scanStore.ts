import { create } from 'zustand';
import {
  DEFAULT_SCAN_CONFIG,
  POLICIES,
  type FitMode,
  type PolicyProfileId,
  type ScanConfig,
} from '../../core/config';
import type { SourceDecision } from '../../core/frames/FrameSource';
import type {
  BackendInfo,
  PerfSnapshot,
  ScanErrorKind,
  ScanPhase,
  ScanResult,
  VideoMeta,
} from '../../core/types';
import type { Capabilities } from '../../core/capabilities';

export type MitigationPolicy = 'blur' | 'block' | 'pregate' | 'off';

export interface VideoSource {
  kind: 'file' | 'url';
  label: string;
  /** Playable URL for the preview player: an object URL for files, the URL itself otherwise. */
  playbackUrl: string;
  file?: File;
  bytes?: number;
}

interface ScanState {
  capabilities: Capabilities | null;
  config: ScanConfig;
  mitigation: MitigationPolicy;

  source: VideoSource | null;
  sourceDecision: SourceDecision | null;
  meta: VideoMeta | null;

  phase: ScanPhase;
  backend: BackendInfo | null;
  result: ScanResult | null;
  perf: PerfSnapshot | null;
  error: { message: string; kind: ScanErrorKind } | null;

  setCapabilities(caps: Capabilities): void;
  setPolicy(id: PolicyProfileId): void;
  setFitMode(fit: FitMode): void;
  setBackendPref(backend: ScanConfig['backend']): void;
  toggle(key: 'earlyExit' | 'dedupe' | 'pauseWhenHidden' | 'regionDetection' | 'violenceDetection'): void;
  setBudget(patch: Partial<ScanConfig['budget']>): void;
  setMitigation(policy: MitigationPolicy): void;

  setSource(source: VideoSource | null): void;
  setSourceDecision(decision: SourceDecision): void;
  setMeta(meta: VideoMeta): void;

  beginScan(): void;
  setPhase(phase: ScanPhase): void;
  setBackendInfo(info: BackendInfo): void;
  setProgress(result: ScanResult, perf: PerfSnapshot): void;
  setError(message: string, kind: ScanErrorKind): void;
  reset(): void;
}

export const useScanStore = create<ScanState>((set, get) => ({
  capabilities: null,
  config: DEFAULT_SCAN_CONFIG,
  mitigation: 'blur',

  source: null,
  sourceDecision: null,
  meta: null,

  phase: 'idle',
  backend: null,
  result: null,
  perf: null,
  error: null,

  setCapabilities(caps) {

    set({ capabilities: caps });
  },

  setPolicy(id) {
    set((s) => ({ config: { ...s.config, policyId: id } }));

  },

  setFitMode(fit) {
    set((s) => ({ config: { ...s.config, fitMode: fit } }));
  },

  setBackendPref(backend) {
    set((s) => ({ config: { ...s.config, backend } }));
  },

  toggle(key) {
    set((s) => ({ config: { ...s.config, [key]: !s.config[key] } }));
  },

  setBudget(patch) {
    set((s) => ({ config: { ...s.config, budget: { ...s.config.budget, ...patch } } }));
  },

  setMitigation(mitigation) {
    set({ mitigation });
  },

  setSource(source) {
    const previous = get().source;

    if (previous?.kind === 'file' && previous.playbackUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previous.playbackUrl);
    }
    set({
      source,
      meta: null,
      result: null,
      perf: null,
      error: null,
      backend: null,
      sourceDecision: null,
      phase: 'idle',
    });
  },

  setSourceDecision(sourceDecision) {
    set({ sourceDecision });
  },

  setMeta(meta) {
    set({ meta });
  },

  beginScan() {
    set({ phase: 'loading-model', result: null, perf: null, error: null });
  },

  setPhase(phase) {
    set({ phase });
  },

  setBackendInfo(backend) {
    set({ backend });
  },

  setProgress(result, perf) {
    set({ result, perf });
  },

  setError(message, kind) {
    set({ error: { message, kind }, phase: 'error' });
  },

  reset() {
    set({
      result: null,
      perf: null,
      error: null,
      phase: 'idle',
      meta: null,
      sourceDecision: null,
    });
  },
}));

export const isScanning = (phase: ScanPhase): boolean =>
  phase === 'loading-model' || phase === 'probing' || phase === 'survey' || phase === 'refine';

export const activePolicy = (config: ScanConfig) => POLICIES[config.policyId];
