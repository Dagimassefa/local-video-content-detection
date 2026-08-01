import { useCallback, useEffect, useMemo, useRef } from 'react';
import { detectCapabilities, budgetFor } from '../../core/capabilities';
import type { ScanEvent } from '../../core/types';
import { ScanController } from '../../workers/ScanController';
import { useScanStore } from '../store/scanStore';

/**
 * Bridges the worker-side {@link ScanController} to the React store.
 *
 * The important detail is that events are BATCHED before they touch React. The worker can emit
 * a refined result every few milliseconds; committing each one immediately would trigger a
 * render per frame and reintroduce exactly the main-thread pressure the workers exist to avoid.
 * Instead, events accumulate and are flushed once per animation frame - React re-renders at
 * most at display refresh rate, which is the fastest rate anything on screen can change anyway.
 */
export function useScanner() {
  const controllerRef = useRef<ScanController | null>(null);

  const store = useScanStore;
  const pending = useRef<ScanEvent[]>([]);
  const rafId = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafId.current = null;
    const events = pending.current;
    pending.current = [];

    const s = store.getState();
    // Only the LAST progress event in a batch matters - each one supersedes the previous, so
    // applying every intermediate result would be wasted work.
    let lastProgress: Extract<ScanEvent, { type: 'progress' | 'done' }> | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'phase':
          s.setPhase(event.phase);
          break;
        case 'model-ready':
          s.setBackendInfo(event.info);
          break;
        case 'meta':
          s.setMeta(event.meta);
          break;
        case 'progress':
        case 'done':
          lastProgress = event;
          break;
        case 'error':
          s.setError(event.message, event.kind);
          break;
      }
    }
    if (lastProgress) s.setProgress(lastProgress.result, lastProgress.perf);
  }, [store]);

  const onEvent = useCallback(
    (event: ScanEvent) => {
      pending.current.push(event);
      
      if (event.type === 'done' || event.type === 'error') {
        if (rafId.current !== null) cancelAnimationFrame(rafId.current);
        flush();
        return;
      }
      if (rafId.current === null) rafId.current = requestAnimationFrame(flush);
    },
    [flush]
  );

  useEffect(() => {
    let cancelled = false;
    void detectCapabilities().then((caps) => {
      if (cancelled) return;
      const s = store.getState();
      s.setCapabilities(caps);
      s.setBudget(budgetFor(caps));
    });

    const controller = new ScanController();
    controllerRef.current = controller;
    controller.warmUp();

    return () => {
      cancelled = true;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      void controller.destroy();
      controllerRef.current = null;
    };
  }, [store]);

  const start = useCallback(async () => {
    const s = store.getState();
    const source = s.source;
    const controller = controllerRef.current;
    if (!source || !controller) return;

    pending.current = [];
    s.beginScan();

    await controller.start({
      input: source.file ? { kind: 'file', file: source.file } : { kind: 'url', url: source.playbackUrl },
      config: s.config,
      onEvent,
      onSourceDecision: (decision) => store.getState().setSourceDecision(decision),
    });
  }, [onEvent, store]);

  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);

  return useMemo(() => ({ start, cancel }), [start, cancel]);
}
