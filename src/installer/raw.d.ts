// `import text from './file?raw'`: the file's text as a string. Vite (Vitest)
// does this natively; scripts/build.mjs's esbuild plugin does the same.
declare module '*?raw' {
  const text: string;
  export default text;
}
