import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const outfile = process.argv[2] ?? 'dist/index.js'
if (process.argv[2] === undefined) {
  await rm('dist', { recursive: true, force: true })
}
await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // Bundled CommonJS dependencies still require Node built-ins at runtime.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
