declare const __GRIMOIRE_VERSION__: string;

/**
 * The package version. Inlined at build time from package.json (esbuild
 * `define` in scripts/build.mjs; Vitest `define` in vitest.config.ts).
 */
export const VERSION: string = __GRIMOIRE_VERSION__;
