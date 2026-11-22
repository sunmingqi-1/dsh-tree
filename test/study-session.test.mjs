import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/client/study.ts', import.meta.url))],
  platform: 'node', format: 'esm', bundle: true, write: false })
const { Study } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('原生首问、分支提交和后台事件使用同一份日志，浏览其他节点不会抢走选择', async () => {
  const sessionId = 's', entries = [], listeners = new Set(), prompts = []
  let parent, refs = 0, revision = 0, change
  const eventSource = { getSnapshot: () => ({ entries, revision, change }), subscribe(f) { listeners.add(f); return () => listeners.delete(f) } }
  const add = (type, data) => {
    const entry = { type: 'event', event: { seq: entries.length, time: Date.now(), type, data } }
    entries.push(entry)
    revision++
    change = { kind: 'append', entries: [entry] }
    for (const f of listeners) f()
    return entry.event.seq
  }
  const input = { bindPromptParent(f) { parent = f; return () => { parent = undefined } } }
  const binding = { ctx: {}, eventSource, session: {
    loadThrough: async () => {},
    beginSubmission() { return { requestId: crypto.randomUUID(), abandon() {} } },
    async prompt(...args) { prompts.push(args); return { ok: true } },
  } }
  const retain = () => { refs++; return { ready: Promise.resolve(binding), release() { refs-- } } }
  const study = new Study({
    conversation: { input: { for: () => input } },
    sessions: { retain, async using(_, __, f) { const ref = retain(); try { return await f(ref) } finally { ref.release() } } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ sessionIds: [sessionId], workspaceId: 'ws' }] }) } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: sessionId }) } } },
  })
  const run = (number, id, requestId, parentSeq, question) => {
    add('turn/start', { turn: number, requestId, parentSeq, metadata: { studyTree: { id } } })
    add('user/message', { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: question }] })
    return add('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  study.armRoot(sessionId)
  await tick()
  const rootRequest = parent()
  assert.equal(rootRequest.parentSeq, null)
  rootRequest.onRequest('first')
  const rootId = rootRequest.metadata.studyTree.id
  add('session/tree', {})
  const rootEnd = run(1, rootId, 'first', null, 'A')
  assert.equal(study.active, rootId)
  assert.equal(parent, undefined)
  const base = study.nodes[0]
  const second = crypto.randomUUID(), c = crypto.randomUUID()
  run(2, second, 'b', rootEnd, 'B')
  const beforeCompact = study.nodes.find(n => n.id === second)
  add('compaction/start', { compactionId: 'k', turn: null })
  const checkpoint = add('compaction/end', { compactionId: 'k', turn: null })
  run(3, c, 'c', rootEnd, 'C')
  assert.equal(study.active, rootId)
  study.open(second)
  await study.submit(beforeCompact, 'D', null)
  const [, mode,, requestId, parentSeq, metadata] = prompts[0]
  assert.equal(mode, 'queue')
  assert.equal(parentSeq, checkpoint)
  study.open(c)
  run(4, metadata.studyTree.id, requestId, parentSeq, 'D')
  assert.equal(study.active, c)
  assert.equal(study.nodes[3].parentId, second)
  assert.deepEqual([...new Set(study.nodes.map(n => n.sessionId))], [sessionId])
  study.open(base.id)
  study.dispose()
  assert.equal(refs, 0)
})
