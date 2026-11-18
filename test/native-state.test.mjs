import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const output = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/nativeState.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const { NativeInteractions, NativeTurns, pendingSource } = await import(
  'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64')
)

function interactionFixture() {
  let openTurn = 1
  const rows = [
    { key: 'user-old', kind: 'user', data: { source: { kind: 'user', rpcId: 'request-old' } },
      location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } } },
    { key: 'tool-old', kind: 'tool-call', data: { root: {
      callId: 'outer-old', subCalls: [{ callId: 'question-old', subCalls: [] }],
    } }, location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } } },
    { key: 'user-new', kind: 'user', data: { source: { kind: 'user', rpcId: 'request-new' } },
      location: { kind: 'step', turn: { turn: 2 }, step: { step: 1 } } },
    { key: 'tool-new', kind: 'tool-call', data: { root: { callId: 'question-new', subCalls: [] } },
      location: { kind: 'step', turn: { turn: 2 }, step: { step: 1 } } },
  ]
  const nodes = new Map(rows.map(row => [row.key, row]))
  const snapshot = { order: rows.map(row => row.key), nodes }
  const turns = new NativeTurns()
  turns.bindings.set('session', {
    target: () => ({ getSnapshot: () => snapshot }),
    openTurn: { getSnapshot: () => openTurn },
  })
  const study = {
    active: 'old', turns,
    nodes: [
      { id: 'old', sessionId: 'session', requestId: 'request-old' },
      { id: 'new', sessionId: 'session', requestId: 'request-new' },
      { id: 'other', sessionId: 'other-session', requestId: 'request-old' },
    ],
    turnNumbers: new Map([['old', 1], ['new', 2], ['other', 1]]),
  }
  return { study, interactions: new NativeInteractions(study), setOpenTurn: turn => { openTurn = turn } }
}

const question = (key, callId) => ({
  key, kind: 'question', sessionId: 'session',
  ...(callId === undefined ? {} : { callId }),
})

test('提问 key 首次绑定后，切卡与 openTurn 变化不转移原问题归属', () => {
  const f = interactionFixture()
  const pending = question('question-one')
  assert.equal(f.interactions.owner(pending), 'old')
  f.study.active = 'new'
  f.setOpenTurn(2)
  f.study.turns.emit()
  assert.equal(f.interactions.owner(pending), 'old')
  // A fresh snapshot object for the same request must keep the same owner.
  assert.equal(f.interactions.owner({ ...pending }), 'old')
  assert.equal(f.interactions.owner(question('question-two')), 'new')
  f.study.active = 'other'
  f.setOpenTurn(undefined)
  assert.equal(f.interactions.owner(pending), 'old')
})

test('同一 Session 的 callId 归原工具轮，无 callId 归首次可定位的当前轮', () => {
  const f = interactionFixture()
  f.setOpenTurn(2)
  assert.equal(f.interactions.owner(question('old-tool', 'question-old')), 'old')
  assert.equal(f.interactions.owner(question('new-tool', 'question-new')), 'new')
  assert.equal(f.interactions.owner(question('current-without-call')), 'new')
  assert.equal(f.interactions.owner(question('unknown-call', 'missing')), undefined)
  assert.equal(f.interactions.owner({ ...question('other-session', 'question-old'), sessionId: 'other-session' }), undefined)
})

for (const [label, callId, openTurn] of [
  ['callId 无匹配', 'not-loaded', 2],
  ['无 callId 且没有 openTurn', undefined, undefined],
]) {
  test(`${label}时，不把轮次尚未解析的卡片猜作问题 owner`, () => {
    const f = interactionFixture()
    f.study.nodes.unshift({ id: 'unresolved', sessionId: 'session', requestId: 'not-loaded' })
    f.setOpenTurn(openTurn)
    assert.equal(f.interactions.owner(question('unresolved-question', callId)), undefined)
  })
}

test('尚未绑定的提问在数据补齐后才认领，不缓存首次解析失败', () => {
  const f = interactionFixture()
  assert.equal(f.interactions.owner(null), undefined)
  const binding = f.study.turns.bindings.get('session')
  f.study.turns.bindings.delete('session')
  const pending = question('waiting-for-binding', 'question-old')
  assert.equal(f.interactions.owner(pending), undefined)
  f.study.turns.bindings.set('session', binding)
  assert.equal(f.interactions.owner(pending), 'old')
})

function observable(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) { snapshot = next; for (const listener of listeners) listener() },
  }
}

for (const mode of ['pendingInteractions', 'sessionStatus']) {
  test(`pendingSource 兼容 ${mode}，保持问题对象身份并支持订阅与释放`, () => {
    const pending = question('stable')
    const wrap = value => mode === 'pendingInteractions' ? value : { running: true, pendingInteraction: value }
    const upstream = observable(new Map([['session', wrap(pending)]]))
    const source = pendingSource({ [mode]: upstream })
    const read = source.get
    assert.strictEqual(read('session'), pending)
    assert.strictEqual(read('session'), read('session'))
    assert.equal(read('unknown'), undefined)
    let notifications = 0
    const stop = source.subscribe(() => { notifications++ })
    upstream.publish(new Map([['session', wrap(pending)], ['other', wrap(question('other'))]]))
    assert.equal(notifications, 1)
    assert.strictEqual(read('session'), pending)
    const replacement = question('replacement')
    upstream.publish(new Map([['session', wrap(replacement)]]))
    assert.strictEqual(read('session'), replacement)
    upstream.publish(new Map())
    assert.equal(read('session'), undefined)
    assert.equal(notifications, 3)
    stop()
    upstream.publish(new Map([['session', wrap(pending)]]))
    assert.equal(notifications, 3)
  })
}

test('两种 pending 源同时存在时，读取和订阅均采用 pendingInteractions', () => {
  const current = question('current')
  const modern = observable(new Map([['session', current]]))
  const legacy = observable(new Map([['session', { pendingInteraction: question('legacy') }]]))
  const source = pendingSource({ pendingInteractions: modern, sessionStatus: legacy })
  let notifications = 0
  const stop = source.subscribe(() => { notifications++ })
  assert.strictEqual(source.get('session'), current)
  legacy.publish(new Map())
  assert.equal(notifications, 0)
  modern.publish(new Map())
  assert.equal(notifications, 1)
  assert.equal(source.get('session'), undefined)
  stop()
})

test('NativeTurns 的订阅与版本局限于所属实例，释放监听不影响其他订阅者', () => {
  const first = new NativeTurns(), second = new NativeTurns()
  const firstVersions = [], retainedVersions = [], secondVersions = []
  const stopFirst = first.subscribe(() => firstVersions.push(first.getSnapshot()))
  const stopRetained = first.subscribe(() => retainedVersions.push(first.getSnapshot()))
  const stopSecond = second.subscribe(() => secondVersions.push(second.getSnapshot()))
  const initialSecond = second.getSnapshot()
  assert.equal(first.getSnapshot(), first.getSnapshot())
  first.emit()
  assert.deepEqual(firstVersions, [1])
  assert.deepEqual(retainedVersions, [1])
  assert.deepEqual(secondVersions, [])
  assert.equal(second.getSnapshot(), initialSecond)
  stopFirst()
  first.emit()
  assert.deepEqual(firstVersions, [1])
  assert.deepEqual(retainedVersions, [1, 2])
  second.emit()
  assert.deepEqual(secondVersions, [1])
  assert.equal(first.getSnapshot(), 2)
  stopRetained(); stopSecond()
  first.emit(); second.emit()
  assert.deepEqual(retainedVersions, [1, 2])
  assert.deepEqual(secondVersions, [1])
})
