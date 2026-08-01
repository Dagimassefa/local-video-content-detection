import { useScanStore } from './store/scanStore'

export function installDebugBridge(): void {
	const w = window as typeof window & {
		__vcd?: unknown
		__vcdLongTasks?: { count: number; worstMs: number }
	}

	w.__vcd = {
		getState: () => useScanStore.getState(),
		setPolicy: (id: 'strict' | 'balanced' | 'permissive') =>
			useScanStore.getState().setPolicy(id),
		setBackendPref: (
			backend: 'auto' | 'webgpu' | 'webgl' | 'wasm' | 'cpu',
		) => useScanStore.getState().setBackendPref(backend),
		setBudget: (patch: Record<string, number>) =>
			useScanStore.getState().setBudget(patch),
		toggle: (
			key:
				| 'earlyExit'
				| 'dedupe'
				| 'pauseWhenHidden'
				| 'regionDetection'
				| 'violenceDetection',
		) => useScanStore.getState().toggle(key),
		setMitigation: (policy: 'blur' | 'block' | 'pregate' | 'off') =>
			useScanStore.getState().setMitigation(policy),
		subscribe: useScanStore.subscribe,
	}

	const tally = { count: 0, worstMs: 0 }
	w.__vcdLongTasks = tally
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				tally.count++
				tally.worstMs = Math.max(tally.worstMs, entry.duration)
			}
		}).observe({ entryTypes: ['longtask'] })
	} catch {
		console.log('PerformanceObserver not supported in this browser.')
	}
}
