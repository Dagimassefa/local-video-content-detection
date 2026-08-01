import { Check, Copy, Gauge } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeCapabilities } from '../../core/capabilities'
import { TIMER } from '../../core/metrics'
import { formatBytes, formatMs } from '../lib/utils'
import { useScanStore } from '../store/scanStore'
import {
	Badge,
	Button,
	Card,
	CardBody,
	CardHeader,
	Stat,
	Tooltip,
} from './ui/primitives'

export function PerfPanel() {
	const perf = useScanStore((s) => s.perf)
	const result = useScanStore((s) => s.result)
	const backend = useScanStore((s) => s.backend)
	const caps = useScanStore((s) => s.capabilities)
	const meta = useScanStore((s) => s.meta)
	const source = useScanStore((s) => s.source)

	const { longTasks, worstTaskMs, fps } = useMainThreadHealth()
	const [copied, setCopied] = useState(false)

	const copyMarkdown = useCallback(async () => {
		const rows = [
			`**Device / browser:** ${navigator.userAgent}`,
			`**Capabilities:** ${caps ? describeCapabilities(caps) : 'n/a'}`,
			`**Video:** ${source?.label ?? 'n/a'} - ${meta ? `${meta.width}x${meta.height}, ${(meta.durationMs / 1000).toFixed(1)}s` : 'n/a'}`,
			`**Frame source:** ${result?.stats.source ?? 'n/a'}${meta?.codec ? ` (${meta.codec})` : ''}`,
			'',
			'| Metric | Value |',
			'| --- | --- |',
			`| Backend resolved | ${backend?.backend ?? 'n/a'} |`,
			`| Model load | ${formatMs(backend?.modelLoadMs)} |`,
			`| Warm-up | ${formatMs(backend?.warmupMs)} |`,
			`| Weights | ${backend ? formatBytes(backend.weightBytes) : 'n/a'}${backend?.servedFromCache ? ' (cache hit)' : ''} |`,
			`| Time to first verdict | ${formatMs(result?.stats.timeToFirstVerdictMs)} |`,
			`| Total scan | ${formatMs(result?.stats.elapsedMs)} |`,
			`| Frames sampled | ${result?.stats.sampledFrames ?? 0} |`,
			`| Frames inferred | ${result?.stats.inferredFrames ?? 0} |`,
			`| Frames deduped | ${result?.stats.dedupedFrames ?? 0} |`,
			`| Decode p50 / p95 | ${formatMs(perf?.timers[TIMER.decode]?.p50)} / ${formatMs(perf?.timers[TIMER.decode]?.p95)} |`,
			`| Inference p50 / p95 | ${formatMs(perf?.timers[TIMER.inference]?.p50)} / ${formatMs(perf?.timers[TIMER.inference]?.p95)} |`,
			`| Per-sample p50 / p95 | ${formatMs(perf?.timers[TIMER.frameTotal]?.p50)} / ${formatMs(perf?.timers[TIMER.frameTotal]?.p95)} |`,
			`| Throughput | ${perf?.throughput ?? 0} inferences/s |`,
			`| tfjs tensors / bytes | ${perf?.tensors?.numTensors ?? 'n/a'} / ${perf?.tensors ? formatBytes(perf.tensors.numBytes) : 'n/a'} |`,
			`| Main-thread long tasks | ${longTasks} (worst ${formatMs(worstTaskMs)}) |`,
			`| Coverage | ${result ? `${Math.round(result.stats.coverage * 100)}%` : 'n/a'} |`,
			`| Stop reason | ${result?.stats.stopReason ?? 'n/a'} |`,
		].join('\n')

		try {
			await navigator.clipboard.writeText(rows)
			setCopied(true)
			setTimeout(() => setCopied(false), 1600)
		} catch {
			console.log('Failed to copy performance table to clipboard.')
		}
	}, [backend, caps, longTasks, meta, perf, result, source, worstTaskMs])

	return (
		<Card>
			<CardHeader
				icon={<Gauge className="h-4 w-4" />}
				title="Performance"
				description="Measured by the app itself. Copy produces the exact table used in docs/04-benchmarks.md."
				actions={
					<Button
						variant="secondary"
						size="sm"
						onClick={copyMarkdown}
					>
						{copied ? (
							<Check className="h-3.5 w-3.5" />
						) : (
							<Copy className="h-3.5 w-3.5" />
						)}
						{copied ? 'Copied' : 'Copy as Markdown'}
					</Button>
				}
			/>
			<CardBody className="space-y-4">
				<div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 sm:grid-cols-4">
					<Tooltip label="Tasks that blocked the main thread for over 50ms. During a scan this should stay at or near zero, because decode and inference both run in workers and frames are transferred worker-to-worker without touching the UI thread.">
						<div>
							<Stat
								label="Long tasks"
								value={longTasks}
								tone={
									longTasks === 0
										? 'ok'
										: longTasks < 5
											? 'default'
											: 'danger'
								}
								hint={
									worstTaskMs > 0
										? `worst ${formatMs(worstTaskMs)}`
										: 'none blocking'
								}
							/>
						</div>
					</Tooltip>
					<Stat
						label="UI frame rate"
						value={`${fps}`}
						tone={
							fps >= 50 ? 'ok' : fps >= 30 ? 'default' : 'danger'
						}
						hint="live, main thread"
					/>
					<Stat
						label="Throughput"
						value={perf ? `${perf.throughput}/s` : '-'}
						hint="inferences per second"
					/>
					<Tooltip label="Live tfjs tensor count. This is the leak canary: it must return to its baseline after a scan, and must not climb across repeated scans.">
						<div>
							<Stat
								label="Tensors"
								value={perf?.tensors?.numTensors ?? '-'}
								hint={
									perf?.tensors
										? formatBytes(perf.tensors.numBytes)
										: 'GPU/CPU held'
								}
							/>
						</div>
					</Tooltip>
				</div>

				<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
					<Stat
						label="Backend"
						value={backend?.backend ?? '-'}
						hint={
							backend?.fallbackReason
								? 'fell back - see below'
								: 'as requested'
						}
					/>
					<Stat
						label="Model load"
						value={formatMs(backend?.modelLoadMs)}
						hint="fetch + build"
					/>
					<Stat
						label="Warm-up"
						value={formatMs(backend?.warmupMs)}
						hint="shader/kernel compile"
					/>
					<Stat
						label="Weights"
						value={backend ? formatBytes(backend.weightBytes) : '-'}
						hint={
							backend?.servedFromCache
								? 'Cache Storage hit'
								: 'raw binary, same-origin'
						}
					/>
					<Stat
						label="Decode p50/p95"
						value={`${formatMs(perf?.timers[TIMER.decode]?.p50)} / ${formatMs(perf?.timers[TIMER.decode]?.p95)}`}
					/>
					<Stat
						label="Inference p50/p95"
						value={`${formatMs(perf?.timers[TIMER.inference]?.p50)} / ${formatMs(perf?.timers[TIMER.inference]?.p95)}`}
					/>
				</dl>

				{backend?.fallbackReason ? (
					<p className="rounded-md border border-warn/25 bg-warn/8 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-warn">
						backend fallback: {backend.fallbackReason}
					</p>
				) : null}

				{caps ? (
					<div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
						<Badge tone="accent">{caps.tier} tier</Badge>
						<Badge>{caps.hardwareConcurrency} cores</Badge>
						{caps.deviceMemoryGb ? (
							<Badge>{caps.deviceMemoryGb} GB</Badge>
						) : null}
						<Badge tone={caps.webgpu ? 'ok' : 'neutral'}>
							webgpu {caps.webgpu ? 'yes' : 'no'}
						</Badge>
						<Badge tone={caps.webcodecs ? 'ok' : 'neutral'}>
							webcodecs {caps.webcodecs ? 'yes' : 'no'}
						</Badge>
						{caps.saveData ? (
							<Badge tone="warn">save-data</Badge>
						) : null}
					</div>
				) : null}
			</CardBody>
		</Card>
	)
}

function useMainThreadHealth() {
	const [longTasks, setLongTasks] = useState(0)
	const [worstTaskMs, setWorstTaskMs] = useState(0)
	const [fps, setFps] = useState(60)
	const frames = useRef(0)
	const lastSecond = useRef(performance.now())

	useEffect(() => {
		let observer: PerformanceObserver | null = null
		try {
			observer = new PerformanceObserver((list) => {
				const entries = list.getEntries()
				setLongTasks((n) => n + entries.length)
				for (const entry of entries) {
					setWorstTaskMs((worst) => Math.max(worst, entry.duration))
				}
			})
			observer.observe({ entryTypes: ['longtask'] })
		} catch {
			console.log('PerformanceObserver not supported in this browser.')
		}

		let raf = 0
		const tick = () => {
			frames.current++
			const now = performance.now()
			if (now - lastSecond.current >= 1000) {
				setFps(
					Math.round(
						(frames.current * 1000) / (now - lastSecond.current),
					),
				)
				frames.current = 0
				lastSecond.current = now
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)

		return () => {
			observer?.disconnect()
			cancelAnimationFrame(raf)
		}
	}, [])

	return { longTasks, worstTaskMs, fps }
}
