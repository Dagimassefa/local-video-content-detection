import { AlertTriangle, Check, Copy, Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { peakCategoryScores } from '../../core/aggregate'
import { CATEGORY_META } from '../../core/categories'
import { activePolicy, useScanStore } from '../store/scanStore'
import { formatMs, percent } from '../lib/utils'
import {
	Badge,
	Button,
	Card,
	CardBody,
	CardHeader,
	Meter,
	Stat,
	Tooltip,
} from './ui/primitives'

export function VerdictCard() {
	const result = useScanStore((s) => s.result)
	const phase = useScanStore((s) => s.phase)
	const config = useScanStore((s) => s.config)
	const policy = activePolicy(config)
	const [copied, setCopied] = useState(false)

	const verdict = result?.verdict
	const positive = verdict?.contains_inappropriate_content === true
	const settled = result?.finalized === true

	const payload = verdict ? JSON.stringify(verdict, null, 2) : null
	// Peak per category, and which one actually drove the verdict.
	const { peaks, driver } = peakCategoryScores(result?.frames ?? [])

	const copy = async () => {
		if (!payload) return
		try {
			await navigator.clipboard.writeText(payload)
			setCopied(true)
			setTimeout(() => setCopied(false), 1600)
		} catch {
			console.log('eror')
		}
	}

	return (
		<Card>
			<CardHeader
				icon={
					positive ? (
						<AlertTriangle className="h-4 w-4 text-danger" />
					) : (
						<ShieldCheck className="h-4 w-4 text-ok" />
					)
				}
				title="Verdict"
				description={
					settled
						? 'Final result for this scan.'
						: result
							? 'Preliminary - refining as more frames are sampled.'
							: 'Run a scan to produce a verdict.'
				}
				actions={
					payload ? (
						<Button variant="secondary" size="sm" onClick={copy}>
							{copied ? (
								<Check className="h-3.5 w-3.5" />
							) : (
								<Copy className="h-3.5 w-3.5" />
							)}
							{copied ? 'Copied' : 'Copy JSON'}
						</Button>
					) : null
				}
			/>
			<CardBody className="space-y-4">
				{!result ? (
					<p className="py-6 text-center text-xs text-muted">
						{phase === 'idle'
							? 'No scan has run yet.'
							: 'Working...'}
					</p>
				) : (
					<>
		
						<div
							aria-live="polite"
							className={[
								'flex items-center justify-between gap-4 rounded-lg border px-3.5 py-3',
								positive
									? 'border-danger/30 bg-danger/8'
									: 'border-ok/30 bg-ok/8',
							].join(' ')}
						>
							<div className="min-w-0">
								<p
									className={[
										'font-mono text-lg leading-none font-semibold tabular-nums',
										positive ? 'text-danger' : 'text-ok',
									].join(' ')}
								>
									{String(positive)}
								</p>
								<p className="mt-1 text-[11px] text-muted">
									contains_inappropriate_content
								</p>
							</div>
							<div className="w-32 shrink-0 text-right">
								<p className="font-mono text-lg leading-none font-semibold tabular-nums text-fg">
									{verdict!.confidence.toFixed(2)}
								</p>
								<p className="mt-1 text-[11px] text-muted">
									confidence
								</p>
								<Meter
									className="mt-1.5"
									value={verdict!.confidence}
									tone={positive ? 'danger' : 'ok'}
									label="confidence"
									valueText={`confidence ${percent(verdict!.confidence)}`}
								/>
							</div>
						</div>

						<pre className="overflow-x-auto rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-fg">
							{payload}
						</pre>

						<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
							<Stat
								label="Frames scored"
								value={result.stats.sampledFrames}
								hint={`${result.stats.inferredFrames} inferred, ${result.stats.dedupedFrames} deduped`}
							/>
							<Tooltip
								label={
									<>
										How much of the timeline our samples can
										reasonably vouch for. Each sample speaks
										for about 2 seconds either side of
										itself, bounded by its neighbours. Low
										coverage is precisely why a
										&quot;clean&quot; verdict on a long
										video reports lower confidence.
									</>
								}
							>
								<div>
									<Stat
										label="Coverage"
										value={percent(result.stats.coverage)}
										tone={
											result.stats.coverage < 0.25
												? 'muted'
												: 'default'
										}
										hint="of the timeline"
									/>
								</div>
							</Tooltip>
							<Tooltip label="Wall-clock until the first publishable verdict. This is deliberately independent of video length - a 30-second clip and a two-hour film both get here in about the same time.">
								<div>
									<Stat
										label="First verdict"
										value={formatMs(
											result.stats.timeToFirstVerdictMs,
										)}
										hint={`total ${formatMs(result.stats.elapsedMs)}`}
									/>
								</div>
							</Tooltip>
							<Stat
								label="Flagged spans"
								value={result.segments.length}
								tone={
									result.segments.length > 0
										? 'danger'
										: 'muted'
								}
								hint={
									result.segments.length > 0
										? 'restricted in the player'
										: 'none found'
								}
							/>
						</dl>

		
						<div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
							<p className="text-[11px] font-medium tracking-wide text-muted uppercase">
								Categories screened
							</p>
							<div className="mt-1.5 flex flex-wrap gap-1.5">
								{result.stats.screenedCategories.map(
									(category) => {
										const hit = peaks.find(
											(p) => p.category === category,
										)
										const isDriver =
											driver === category &&
											(hit?.peak ?? 0) > 0
										return (
											<Tooltip
												key={category}
												label={
													<>
														{
															CATEGORY_META[
																category
															].description
														}
														{hit ? (
															<>
																{' '}
																<strong>
																	Peak{' '}
																	{hit.peak.toFixed(
																		3,
																	)}{' '}
																	across this
																	scan.
																</strong>
															</>
														) : null}
													</>
												}
											>
				
												<Badge
													tone={
														isDriver
															? 'danger'
															: 'ok'
													}
												>
													{
														CATEGORY_META[category]
															.label
													}
													{hit ? (
														<span className="ml-1 font-mono tabular-nums opacity-80">
															{hit.peak.toFixed(
																2,
															)}
														</span>
													) : null}
												</Badge>
											</Tooltip>
										)
									},
								)}
								{result.stats.unscreenedCategories.map(
									(category) => (
										<Tooltip
											key={category}
											label={`NOT screened. ${CATEGORY_META[category].requires ?? ''}`}
										>
											<Badge className="opacity-55 line-through decoration-1">
												{CATEGORY_META[category].label}
											</Badge>
										</Tooltip>
									),
								)}
							</div>
							<p className="mt-2 text-[11px] leading-relaxed text-muted">
								Numbers are the{' '}
								<strong className="text-fg">peak score</strong>{' '}
								for that category across the scan; the red one
								drove the verdict. Struck-through categories
								were{' '}
								<strong className="text-fg">
									not examined
								</strong>{' '}
								— a clean verdict says nothing about them. Both
								lists are carried in{' '}
								<code className="font-mono">stats</code> so an
								integrator can check programmatically.
							</p>
						</div>

						<div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
							<Badge tone="accent">{policy.label} policy</Badge>
							<Badge>
								threshold {policy.frameThreshold.toFixed(2)}
							</Badge>
							<Badge>
								{result.stats.source === 'webcodecs'
									? 'WebCodecs decode'
									: 'video-element decode'}
							</Badge>
							{result.stats.backend ? (
								<Badge>{result.stats.backend}</Badge>
							) : null}
							{result.stats.stopReason ? (
								<Tooltip
									label={stopReasonExplanation(
										result.stats.stopReason,
									)}
								>
									<Badge
										tone={
											result.stats.stopReason ===
											'complete'
												? 'ok'
												: 'warn'
										}
									>
										{result.stats.stopReason}
									</Badge>
								</Tooltip>
							) : (
								<Badge tone="accent">
									<Loader2 className="h-3 w-3 animate-spin" />
									scanning
								</Badge>
							)}
						</div>
					</>
				)}
			</CardBody>
		</Card>
	)
}

function stopReasonExplanation(reason: string): string {
	switch (reason) {
		case 'complete':
			return 'Every interval worth sampling was sampled - the scan ran to natural completion.'
		case 'early-exit':
			return 'The evidence was decisive, so sampling stopped rather than spending more battery confirming what was already clear.'
		case 'frame-budget':
			return 'The frame budget was reached. The verdict reflects the frames sampled so far; raise maxFrames to look harder.'
		case 'time-budget':
			return 'The wall-clock budget was reached. Coverage will be lower than a full scan would achieve.'
		case 'cancelled':
			return 'You cancelled the scan. The verdict reflects whatever had been sampled at that point.'
		default:
			return 'The scan stopped early because of an error.'
	}
}
