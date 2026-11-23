import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { applyPatch, parsePatch } from 'diff'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const version = '0.2.2-rc.5'
const patchDirectory = new URL('../runtime/patches/', import.meta.url)

// npm ci supplies the published, integrity-locked sources. Apply reviewed
// changes to esbuild input in memory; never write into a DSH installation.
export async function buildRuntime() {
  const entries = {
    host: 'src/host/index.js',
    'runtime/session-store': 'src/host/sessionStore.js',
    'runtime/branch-routing': 'src/host/routing.js',
    'runtime/branch-history': 'src/host/ancestry.js',
    'runtime/preset-registry': 'src/host/presetRegistry.js',
  }
  const inputs = new Map()
  // Cordis publishes FiberState as a TypeScript const enum. The shared
  // runtime exports its services, while the upstream compiler inlines this enum.
  const cordis = await readFile(require.resolve('@deepseek-ai/cordis/src/fiber.ts'), 'utf8')
  const fiberState = cordis.match(/^export (const enum FiberState \{[^}]+\})/m)?.[1]
  if (!fiberState) throw new Error('Cannot find the pinned Cordis FiberState declaration')
  for (const file of (await readdir(patchDirectory)).sort()) {
    if (!file.endsWith('.patch')) continue
    const service = file.slice(0, -6)
    const upstream = { 'persistence-jsonl': 'session-persistence-jsonl', 'session-query': 'session-query-sqlite' }[service] ?? service
    const manifest = require.resolve('@deepseek-ai/dsh-' + upstream + '/package.json')
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    if (metadata.version !== version) throw new Error('Unsupported upstream version: ' + metadata.name + '@' + metadata.version)
    const directory = dirname(manifest)
    entries['runtime/' + service] = join(directory, 'src/index.ts')
    for (const patch of parsePatch(await readFile(new URL(file, patchDirectory), 'utf8'))) {
      const local = patch.newFileName?.replace(/^b\//, '')
      if (!local?.startsWith('src/')) throw new Error('Invalid source path in ' + file)
      const path = resolve(directory, local)
      if (!path.startsWith(join(directory, 'src') + sep) || inputs.has(path)) throw new Error('Invalid patch target: ' + path)
      const original = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
      const updated = applyPatch(original, patch)
      if (updated === false) throw new Error('Patch no longer matches ' + metadata.name + '/' + local)
      inputs.set(path, updated)
    }
  }
  const used = new Set()
  await build({
    entryPoints: entries,
    outdir: 'dist',
    bundle: true,
    splitting: true,
    chunkNames: 'runtime/shared/[name]-[hash]',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    external: ['@deepseek-ai/*', 'dsh-study-tree/*'],
    plugins: [{
      name: 'study-tree-pinned-sources',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (!inputs.has(path) && !path.includes(sep + '@deepseek-ai' + sep)) return
          let contents = inputs.get(path) ?? await readFile(path, 'utf8')
          if (inputs.has(path)) used.add(path)
          contents = contents.replace(/^import \{([^}]*\bFiberState\b[^}]*)\} from '@deepseek-ai\/cordis'/m, (_, names) => {
            const keep = names.split(',').map(name => name.trim()).filter(name => name !== 'FiberState')
            return fiberState + '\n' + (keep.length ? "import { " + keep.join(', ') + " } from '@deepseek-ai/cordis'" : '')
          })
          return { contents, loader: 'ts', resolveDir: dirname(path) }
        })
      },
    }],
  })
  for (const path of inputs.keys()) if (!used.has(path)) throw new Error('Unused patch target: ' + path)
}
