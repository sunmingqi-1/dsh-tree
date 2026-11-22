import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TreeLog } from '../src/treeLog.js'
import { apply } from '../src/host/index.js'

const source = id => ({ kind: 'user', rpcId: 'ask-' + id })
const root = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID(), d = crypto.randomUUID()
const anchor = { text: '这一句', start: 8, prefix: '前文', suffix: '后文' }
function scenario() {
  const events = []
  const add = (type, data) => {
    const seq = events.length
    events.push({ type, seq, time: 1000 + seq, data })
    return seq
  }
  add('session/tree', {})
  const turn = (number, id, parentSeq, text, anchor) => {
    const start = { turn: number, parentSeq, requestId: source(id).rpcId,
      metadata: { studyTree: { id, ...(anchor && { anchor }) } } }
    const message = { source: source(id), content: [{ type: 'text', text }] }
    add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    add('turn/start', start)
    add('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    add('user/message', message)
    add('user/message', { source: { kind: 'tool', rpcId: 'not-a-card' }, content: [] })
    return add('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  const endA = turn(1, root, null, 'A')
  const endB = turn(2, b, endA, 'B')
  add('compaction/start', { turn: null, compactionId: 'summary' })
  const compactB = add('compaction/end', { turn: null, compactionId: 'summary' })
  turn(3, c, endA, 'C')
  turn(4, d, compactB, '> 这一句\n\nD', anchor)
  return { events, endB, compactB }
}
test('同一日志 A→B、A→C、B→D 重建父链、压缩边界与精确引用', () => {
  const { events, endB, compactB } = scenario()
  const log = new TreeLog('session')
  for (const event of events) log.append(event)
  assert.deepEqual([...log.nodes.values()].map(n => [n.id, n.parentId, n.question]), [
    [root, null, 'A'], [b, root, 'B'], [c, root, 'C'], [d, b, 'D'],
  ])
  assert.deepEqual(log.nodes.get(d).anchor, anchor)
  assert.equal(log.nodes.get(b).endSeq, endB)
  assert.equal(log.nodes.get(b).boundarySeq, compactB)
})
test('在 user/message 入盘前中断的已开轮提问，重启后仍对应原卡片', () => {
  const { events } = scenario()
  const log = new TreeLog('session')
  for (const event of events.slice(0, 3)) log.append(event)
  assert.equal(log.nodes.get(root).status, 'sending')
  log.append({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(log.nodes.get(root).status, 'stopped')
})
test('清空节点表再启动，list 只依赖宿主日志并增量读取', async () => {
  const { events } = scenario()
  const notes = new Map()
  const offsets = []
  let size = 7, closed = 0, store
  await apply({
    storageDomain: { open: async () => ({ table: () => ({ get: k => notes.get(k), entries: () => notes.entries(), put: async (k, n) => notes.set(k, n) }), close() {} }) },
    sessionPersistence: {
      list: async () => [{ header: { id: 's' }, revision: String(size) }],
      open: async () => ({
        read: async (offset, length) => { offsets.push(offset); return { events: events.slice(0, size).slice(offset, offset + length) } },
        close: async () => { closed++ },
      }),
    },
    effect() {}, provide(_, value) { store = value }, typert: { register() {} },
  })
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.list()).length, 1)
  size = events.length
  const rows = await store.list()
  assert.deepEqual(rows.map(n => n.parentId), [null, root, root, b])
  assert.equal(rows[3].sessionId, 's')
  assert.deepEqual(offsets, [0, 7])
  const named = await store.save({ ...rows[3], title: '复习 D' })
  assert.equal(named.revision, 1)
  assert.equal((await store.list()).find(row => row.id === d).title, '复习 D')
  assert.equal(notes.has(b), false)
  assert.equal(closed, 2)
})

test('宿主后台轮的独立压缩不能改写可见父卡片的边界', () => {
  const { events } = scenario()
  const log = new TreeLog('session')
  for (const event of events) log.append(event)
  const original = log.nodes.get(d).boundarySeq
  const extra = (type, data) => log.append({ type, data, seq: log.nextSeq })
  extra('turn/start', { turn: 5 })
  extra('turn/end', { turn: 5, reason: { kind: 'completed' } })
  extra('compaction/start', { turn: null, compactionId: 'hidden' })
  extra('compaction/end', { turn: null, compactionId: 'hidden' })
  assert.equal(log.nodes.get(d).boundarySeq, original)
})
