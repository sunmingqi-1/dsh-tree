import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/study.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const { Study } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(continued = false) {
  const root = { id: 'root', treeId: 'root', parentId: null, sessionId: 'source', endSeq: 3, requestId: 'first', question: '根问题', status: 'complete' }
  const bindings = new Map(), forks = [], opened = [], watched = []
  let held = 0
  const binding = (id, events) => {
    const listeners = new Set(), entries = events.map(event => ({ event }))
    const result = { session: { loadThrough: async () => {} }, eventSource: {
      getSnapshot: () => ({ entries }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    }, add(event) { entries.push({ event }); for (const fn of listeners) fn() }, notify() { for (const fn of listeners) fn() } }
    bindings.set(id, result)
    return result
  }
  binding('source', [
    { type: 'user/message', seq: 1, data: { source: { rpcId: 'first' }, content: [{ type: 'text', text: '根问题' }] } },
    { type: 'turn/end', seq: 3 },
    ...continued ? [{ type: 'user/message', seq: 5, data: { source: { rpcId: 'outside' } } }] : [],
  ])
  const study = new Study({ sessions: {
    list: { getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map(id => [id, {}])) }) },
    retain: id => { held++; let released = false; return { ready: Promise.resolve(bindings.get(id)), release() { assert.equal(released, false); released = true; held-- } } },
    fork: async options => { forks.push(options); binding('fork', bindings.get(options.sessionId).eventSource.getSnapshot().entries.map(e => e.event).filter(e => e.seq <= options.atSeq)); return 'fork' },
  } })
  study.nodes = [root]; study.enabled = true
  study.save = async node => { study.nodes = [...study.nodes, node]; return node }
  study.showSession = id => opened.push(id)
  study.open = id => opened.push(id)
  study.watch = node => watched.push(node)
  return { study, root, bindings, forks, opened, watched, held: () => held }
}

test('原生输入的消息只记录一次并绑定当前节点，保留 DSH 自己的提交过程', async () => {
  const f = fixture(), stop = f.study.followNative(f.root)
  await tick()
  f.bindings.get('source').add({ type: 'user/message', seq: 4, data: { source: { rpcId: 'native-new' }, content: [{ type: 'text', text: '新的问题' }] } })
  f.bindings.get('source').notify()
  await tick()
  assert.equal(f.study.nodes.length, 2)
  assert.deepEqual(f.forks, [])
  assert.equal(f.study.nodes[1].parentId, 'root')
  assert.equal(f.study.nodes[1].question, '新的问题')
  assert.equal(f.study.nodes[1].requestId, 'native-new')
  assert.equal(f.watched.length, 1)
  stop(); assert.equal(f.held(), 0)
})

test('从旧卡片使用原生输入前先按结束序号分叉，不继承后续问答', async () => {
  const f = fixture(true), stop = f.study.followNative(f.root)
  await tick()
  assert.deepEqual(f.forks, [{ sessionId: 'source', atSeq: 3 }])
  assert.equal(f.study.readerTarget.sessionId, 'fork')
  f.bindings.get('fork').add({ type: 'user/message', seq: 4, data: { source: { rpcId: 'sibling' }, content: [{ type: 'text', text: '另一分支' }] } })
  await tick()
  assert.equal(f.study.nodes.length, 2)
  assert.equal(f.study.nodes[1].parentId, 'root')
  assert.equal(f.study.nodes[1].sessionId, 'fork')
  assert.equal(f.study.nodes[1].requestId, 'sibling')
  stop(); assert.equal(f.held(), 0)
})
