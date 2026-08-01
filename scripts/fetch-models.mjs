#!/usr/bin/env node
/**
 * Vendors the NSFWJS MobileNetV2 weights into `public/models/` as RAW BINARY.
 *
 * Why this script exists at all — this is a deliberate, measured decision:
 *
 *   The `nsfwjs` npm package ships its weights as base64 embedded inside JS modules
 *   (`dist/models/mobilenet_v2/group1-shard1of1.min.js` = 3,493,394 bytes of JavaScript).
 *   Importing that means the JS engine must PARSE 3.5 MB of source, base64-decode it, and
 *   keep it in the module graph forever. On a mid-range phone that is a multi-hundred-
 *   millisecond stall before a single frame is ever classified.
 *
 *   The same weights exist upstream as raw binary: 2,619,461 bytes. Serving those as static
 *   assets gives us:
 *     - ~25% fewer bytes over the wire (no base64 inflation)
 *     - zero JS parse cost (tfjs fetches an ArrayBuffer straight into tensors)
 *     - normal HTTP caching + Cache Storage / OPFS persistence for warm starts
 *     - lazy loading: weights are fetched when a scan starts, not on page load
 *
 * Pinned to an immutable commit SHA so builds are reproducible, with size + SHA-256
 * verification so a silently-changed upstream file fails loudly instead of quietly
 * degrading detection quality.
 *
 * `--soft` (used by postinstall) never fails the install; it prints guidance instead.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** Immutable upstream pin - the last commit that touched `models/mobilenet_v2`. */
const UPSTREAM_COMMIT = '39aa4cb99cd3fce492da8f4add6500a75a5ef774'
const UPSTREAM_BASE = `https://raw.githubusercontent.com/infinitered/nsfwjs/${UPSTREAM_COMMIT}/models`

const MODEL = {
	id: 'mobilenet_v2',
	/** Directory tfjs is pointed at. `nsfwjs` appends `model.json` itself. */
	dir: 'public/models/mobilenet_v2',
	inputSize: 224,
	/** A tfjs LayersModel (not a GraphModel) - so no `{ type: 'graph' }` at load time. */
	format: 'tfjs-layers-model',
	files: [
		{ name: 'model.json', bytes: 128945 },
		// NB: no file extension upstream. model.json's weightsManifest references this exact name.
		{ name: 'group1-shard1of1', bytes: 2619461 },
	],
}

/**
 * The violence detector, vendored ONLY on request.
 *
 * `onnx-community/vit-base-violence-detection-ONNX` int8 - a ViT-base fine-tuned on the Real Life
 * Violence Situations dataset, exported and quantised by the ONNX community org.
 *
 * **It is 86.8 MB, which is 33x the NSFW classifier.** That is not a rounding error, it is the whole
 * reason this is opt-in and off by default: shipping it as standard would take the cold-start payload
 * from 2.62 MB to ~89 MB and destroy the mobile story the rest of the project is built around. There is
 * no MobileNet-class violence model published anywhere - every option is a 327 MB ViT, and 86.8 MB is
 * the smallest quantisation that reliably runs under onnxruntime-web.
 *
 * So: the default install stays small, and anyone who wants violence screening opts in explicitly and
 * knowingly pays for it. Vendored locally rather than fetched from Hugging Face at runtime, because a
 * runtime CDN call would break the "runs entirely locally, no external calls" property that
 * `npm run verify` asserts.
 *
 *     npm run models -- --violence
 */
const VIOLENCE_MODEL = {
	id: 'vit-violence',
	dir: 'public/models/vit-violence',
	inputSize: 224,
	/** ViTFeatureExtractor: rescale to [0,1], then normalise with mean=std=0.5 -> [-1, 1]. */
	normalize: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
	/**
	 * Label order is NOT declared in the model's config (`id2label` is absent from the export), so it is
	 * asserted here from the dataset's alphabetical class order (NonViolence < Violence) and then
	 * VERIFIED EMPIRICALLY by `scripts/eval-violence-model.mjs`. Getting this backwards would invert
	 * every violence verdict silently, which is the worst possible failure mode - hence the separate
	 * check rather than a comment saying "should be fine".
	 */
	labels: ['NonViolence', 'Violence'],
	violenceIndex: 1,
	files: [
		{
			name: 'model.onnx',
			bytes: 86803109,
			url: 'https://huggingface.co/onnx-community/vit-base-violence-detection-ONNX/resolve/main/onnx/model_quantized.onnx',
		},
	],
}

const SOFT = process.argv.includes('--soft')
const FORCE = process.argv.includes('--force')
const WITH_VIOLENCE = process.argv.includes('--violence')

const log = (...a) => console.log('[models]', ...a)
const warn = (...a) => console.warn('[models]', ...a)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function sizeOf(path) {
	try {
		return (await stat(path)).size
	} catch {
		return -1
	}
}

/** Bounded retries - a transient CDN failure should not break `npm install`. */
async function download(url, attempts = 3) {
	let lastErr
	for (let i = 1; i <= attempts; i++) {
		try {
			const res = await fetch(url, { redirect: 'follow' })
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
			return Buffer.from(await res.arrayBuffer())
		} catch (err) {
			lastErr = err
			if (i < attempts) {
				const backoff = 400 * 2 ** (i - 1)
				warn(
					`attempt ${i}/${attempts} failed for ${url} (${err.message}); retrying in ${backoff}ms`,
				)
				await new Promise((r) => setTimeout(r, backoff))
			}
		}
	}
	throw lastErr
}

/**
 * Vendor the tfjs WASM binaries into `public/tfjs/`.
 *
 * The WASM backend is the fallback that matters: it is the difference between "works slowly"
 * and "does not work" on a device where WebGL is blocked or the GPU is blocklisted. tfjs
 * cannot resolve these binaries from a bundled module graph, so they have to be real static
 * assets with a path handed to `setWasmPaths()`.
 *
 * All three variants are copied and tfjs picks at runtime. Note that the threaded build needs
 * SharedArrayBuffer, which needs COEP, which we deliberately do NOT enable because it would
 * break cross-origin video URLs - so in practice the single-threaded SIMD build is what runs.
 * See the comment in `vite.config.ts`.
 */
async function vendorWasm() {
	const from = join(ROOT, 'node_modules/@tensorflow/tfjs-backend-wasm/dist')
	const to = join(ROOT, 'public/tfjs')
	const files = [
		'tfjs-backend-wasm.wasm',
		'tfjs-backend-wasm-simd.wasm',
		'tfjs-backend-wasm-threaded-simd.wasm',
	]

	if ((await sizeOf(join(from, files[0]))) < 0) {
		warn('tfjs-backend-wasm is not installed; skipping WASM asset copy.')
		return
	}
	await mkdir(to, { recursive: true })
	let copied = 0
	for (const name of files) {
		const src = join(from, name)
		if ((await sizeOf(src)) < 0) continue
		await copyFile(src, join(to, name))
		copied++
	}
	log(`vendored ${copied} tfjs WASM binaries into public/tfjs/`)
}

/**
 * Vendor ONNX Runtime Web's own WASM binaries into `public/ort/`.
 *
 * Without these, `ort.env.wasm.wasmPaths` falls back to a jsDelivr CDN - which would mean enabling
 * violence detection silently breaks the "runs entirely locally, no external calls" property that
 * `npm run verify` asserts. An optional feature quietly invalidating the headline guarantee is
 * exactly the kind of regression that ships unnoticed.
 */
async function vendorOrtRuntime() {
	const from = join(ROOT, 'node_modules/onnxruntime-web/dist')
	const to = join(ROOT, 'public/ort')
	if ((await sizeOf(from)) < 0 && !(await stat(from).catch(() => null))) {
		warn('onnxruntime-web is not installed; skipping ORT runtime copy.')
		return
	}
	await mkdir(to, { recursive: true })

	// ONLY the files actually loaded, not the whole dist directory.
	//
	// onnxruntime-web ships 26 build variants totalling ~93 MB - webgl, training, asyncify, JSPI,
	// source maps, the lot. Copying all of them put 93 MB into `public/`, which Vite then copies into
	// `dist/` on every build, taking the production output to 209 MB and making a mockery of the
	// 115 KB eager-bundle figure this project reports. Four files are needed:
	//
	//   ort.wasm.mjs                 the WASM-only entry point
	//   ort-wasm-simd-threaded.wasm  the kernel binary
	//   ort-wasm-simd-threaded.mjs   its loader
	//
	// WASM only, no WebGPU. The JSEP binary WebGPU dispatches through is 26 MB on its own, and this
	// model is both disabled by default and unfit to enable - paying 26 MB to accelerate something
	// nobody should be running is the wrong trade. If a checkpoint ever passes the evaluation, adding
	// the two JSEP files back is a one-line change.
	const NEEDED = [
		'ort.wasm.mjs',
		'ort-wasm-simd-threaded.wasm',
		'ort-wasm-simd-threaded.mjs',
	]
	let copied = 0
	let bytes = 0
	for (const name of NEEDED) {
		const src = join(from, name)
		const size = await sizeOf(src)
		if (size < 0) continue
		await copyFile(src, join(to, name))
		copied++
		bytes += size
	}
	log(
		`vendored ${copied} ONNX Runtime files into public/ort/ (${(bytes / 1048576).toFixed(1)} MiB)`,
	)
}

/** Vendor the opt-in violence model. Large, so it reports progress. */
async function vendorViolence() {
	await vendorOrtRuntime()

	const outDir = join(ROOT, VIOLENCE_MODEL.dir)
	await mkdir(outDir, { recursive: true })

	const entries = []
	let totalBytes = 0

	for (const file of VIOLENCE_MODEL.files) {
		const target = join(outDir, file.name)
		if (!FORCE && (await sizeOf(target)) === file.bytes) {
			log(`${file.name} already vendored`)
			const buf = await readFile(target)
			entries.push({
				name: file.name,
				bytes: buf.byteLength,
				sha256: sha256(buf),
			})
			totalBytes += buf.byteLength
			continue
		}
		log(
			`fetching ${file.name} (${(file.bytes / 1048576).toFixed(1)} MiB - this takes a while)`,
		)
		const buf = await download(file.url)
		if (buf.byteLength !== file.bytes) {
			throw new Error(
				`size mismatch for ${file.name}: got ${buf.byteLength}, expected ${file.bytes}`,
			)
		}
		await writeFile(target, buf)
		const digest = sha256(buf)
		entries.push({ name: file.name, bytes: buf.byteLength, sha256: digest })
		totalBytes += buf.byteLength
		log(`  ok  ${file.name}  sha256=${digest.slice(0, 16)}...`)
	}

	await writeFile(
		join(outDir, 'manifest.json'),
		`${JSON.stringify(
			{
				id: VIOLENCE_MODEL.id,
				description:
					'ViT-base fine-tuned for violence detection (Real Life Violence Situations), int8 ONNX.',
				upstream: {
					repo: 'https://huggingface.co/onnx-community/vit-base-violence-detection-ONNX',
					base: 'https://huggingface.co/jaranohaal/vit-base-violence-detection',
					license: 'apache-2.0',
				},
				inputSize: VIOLENCE_MODEL.inputSize,
				normalize: VIOLENCE_MODEL.normalize,
				labels: VIOLENCE_MODEL.labels,
				violenceIndex: VIOLENCE_MODEL.violenceIndex,
				totalBytes,
				files: entries,
			},
			null,
			2,
		)}\n`,
	)

	log(
		`done - ${VIOLENCE_MODEL.id}: ${(totalBytes / 1048576).toFixed(1)} MiB ` +
			`(33x the NSFW model - opt-in for exactly that reason)`,
	)
	log('now verify the label order:  node scripts/eval-violence-model.mjs')
}

async function main() {
	await vendorWasm()
	await vendorNsfw()

	if (WITH_VIOLENCE) {
		await vendorViolence()
	} else if (
		(await sizeOf(join(ROOT, VIOLENCE_MODEL.dir, 'model.onnx'))) < 0
	) {
		log(
			'violence detection not vendored (86.8 MB, opt-in). Enable with:  npm run models -- --violence',
		)
	}
}

async function vendorNsfw() {
	const outDir = join(ROOT, MODEL.dir)
	await mkdir(outDir, { recursive: true })

	if (!FORCE) {
		const sizes = await Promise.all(
			MODEL.files.map((f) => sizeOf(join(outDir, f.name))),
		)
		const complete = MODEL.files.every((f, i) => sizes[i] === f.bytes)
		const manifestPresent =
			(await sizeOf(join(outDir, 'manifest.json'))) > 0
		if (complete && manifestPresent) {
			log(
				`already vendored (${MODEL.id}) - nothing to do. Use --force to re-download.`,
			)
			return
		}
	}

	const entries = []
	let totalBytes = 0

	for (const file of MODEL.files) {
		const url = `${UPSTREAM_BASE}/${MODEL.id}/${file.name}`
		log(`fetching ${file.name} (expect ${file.bytes.toLocaleString()} B)`)
		const buf = await download(url)

		if (buf.byteLength !== file.bytes) {
			throw new Error(
				`size mismatch for ${file.name}: got ${buf.byteLength}, expected ${file.bytes}. ` +
					`Upstream may have changed - verify before trusting these weights.`,
			)
		}

		await writeFile(join(outDir, file.name), buf)
		const digest = sha256(buf)
		entries.push({ name: file.name, bytes: buf.byteLength, sha256: digest })
		totalBytes += buf.byteLength
		log(`  ok  ${file.name}  sha256=${digest.slice(0, 16)}...`)
	}

	const modelJson = JSON.parse(
		await readFile(join(outDir, 'model.json'), 'utf8'),
	)
	const referenced = (modelJson.weightsManifest ?? []).flatMap(
		(g) => g.paths ?? [],
	)
	const missing = referenced.filter((p) => !entries.some((e) => e.name === p))
	if (missing.length) {
		throw new Error(
			`model.json references weight files we did not fetch: ${missing.join(', ')}`,
		)
	}

	const manifest = {
		id: MODEL.id,
		description:
			'NSFWJS MobileNetV2 transfer-learning classifier (5-class), raw binary weights.',
		upstream: {
			repo: 'https://github.com/infinitered/nsfwjs',
			commit: UPSTREAM_COMMIT,
			path: `models/${MODEL.id}`,
		},
		format: MODEL.format,
		inputSize: MODEL.inputSize,
		classes: ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'],
		totalBytes,
		files: entries,
	}
	await writeFile(
		join(outDir, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
	)

	log(
		`done - ${MODEL.id}: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB raw binary ` +
			`(vs 3.60 MiB as base64-in-JS from the npm package)`,
	)
}

main().catch((err) => {
	if (SOFT) {
		warn(`could not vendor model weights: ${err.message}`)
		warn('the app will not be able to scan until you run:  npm run models')
		process.exit(0)
	}
	console.error('[models] FAILED:', err.message)
	process.exit(1)
})
