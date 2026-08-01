import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The test suite covers `src/core` only, and runs in plain Node with no DOM shim.
 *
 * That is not a gap, it is the design paying off. Every decision worth testing - how class
 * probabilities become a score, how sparse samples become a verdict and a confidence, which
 * timestamp to look at next, how a device maps to a budget - lives in pure functions with no
 * DOM, no GPU and no video dependency. They run in milliseconds and are deterministic.
 *
 * What is deliberately NOT unit-tested: the frame sources, the classifier and the workers.
 * Those are thin adapters over browser APIs whose behaviour (seek timing, GPU backend
 * selection, hardware decode) cannot be meaningfully faked - a mock of `VideoDecoder` would
 * only assert that the mock was called. They are verified in the browser instead, via the
 * checks in the README and the `/bench` harness.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
