import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  worker: {
    // ES module workers, so the workers can use the same dynamic `import()` splitting as the
    // app. The heavy tfjs chunk is then shared rather than duplicated into the worker bundle.
    format: 'es',
  },

  server: {
    port: 5173,
    /**
     * Deliberately NOT setting Cross-Origin-Embedder-Policy.
     *
     * COEP: require-corp would unlock SharedArrayBuffer and therefore multi-threaded WASM,
     * which would meaningfully speed up the CPU fallback backend. But it also forces every
     * cross-origin subresource to opt in via CORP headers - and that includes remote video
     * URLs, which is one of the two input methods the challenge requires. Arbitrary video URLs
     * do not send CORP headers, so enabling COEP would break URL ingestion entirely.
     *
     * Given the choice between a faster fallback backend and supporting half the required
     * inputs, the inputs win. Documented in docs/03-tradeoffs-and-alternatives.md.
     */
    headers: {},
  },

  build: {
    target: 'es2022',
    // The point of the size report is to show that the ML runtime is code-split away from the
    // initial load, so the warning threshold is set where a regression would be interesting.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep tfjs and nsfwjs in their own chunk. They are dynamically imported when a scan
          // starts, so a visitor who never scans anything never downloads them.
          if (id.includes('@tensorflow') || id.includes('nsfwjs')) return 'ml-runtime';
          if (id.includes('mp4box')) return 'demuxer';
          return undefined;
        },
      },
    },
  },
});
