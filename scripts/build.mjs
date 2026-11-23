import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { buildRuntime } from './build-runtime.mjs'
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  outdir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text
const css = result.outputFiles.find((f) => f.path.endsWith('.css')).text
await mkdir('dist', { recursive: true })
const artifact = `window.__ModuleLoader__.load({id:"dsh-study-tree",factory(require){const module={exports:{}};const exports=module.exports;const STUDY_CSS=${JSON.stringify(css)};\n${js}\nreturn module.exports}});`
new Function(artifact)
await writeFile('dist/client.js', artifact)
await buildRuntime()
