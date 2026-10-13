// The dashboard build (Vite + Preact). scripts/build.mjs runs it into dist/dashboard/;
// `npm run dev:dashboard` serves it for UI work.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/surfaces/dashboard', import.meta.url)),
  base: '/',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/dashboard', import.meta.url)),
    emptyOutDir: true,
    // Served under a CSP with no inline script or style and font-src 'self' (spec §20):
    // no modulepreload polyfill (an inline script) and no assets inlined as data: URIs.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
