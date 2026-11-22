import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session } from '@deepseek-ai/dsh-session'
import StudyTreeSessionStore from '../src/host/sessionStore.js'
import { prepareTreePrompt, routeTreeInput, treePath } from '../src/host/routing.js'
import { apply as mountStudyTree } from '../src/host/index.js'
import { activePathEvents, decodeTreeRows, encodeTreeRows } from '../src/host/ancestry.js'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

async function context() {
  const ctx = new Context()
  await ctx.plugin(StudyTreeSessionStore)
  return ctx
}
const message = (text, id) => createUserMessage({ source: { kind: 'user', ...(id && { rpcId: id }) },
  content: [{ type: 'text', text }] })
const appendMessage = (s, text) => s.append('user/message', message(text), { surfaceOp: 'append' }).seq
const end = (s, turn) => s.append('turn/end', { turn, reason: { kind: 'completed' } }).seq
const textOf = s => s.deriveMessages().map(m => m.content[0].text)
const header = (s, model) => {
  s.append('request/context', { provider: 'test', model })
  s.append('request/header', { reason: 'series', header: { config: { provider: 'test', model },
    tools: [{ name: model, description: model, parameters: {} }] } })
}

test('rc.5 的分支回退同步恢复真实 Session 的消息、请求头、工具和压缩，冷启动重放相同', async () => {
  const ctx = await context(), s = ctx.sessions.create('tree')
  const seen = []
  ctx.on('session/event', (session, event) => {
    if (session === s && event.type === 'turn/start') seen.push(textOf(session))
  })
  ctx.sessions.declareStudyTree(s)
  s.append('turn/start', { turn: 1, parentSeq: null })
  const a = appendMessage(s, 'A')
  header(s, 'base')
  const endA = end(s, 1)
  s.append('turn/start', { turn: 2, parentSeq: endA })
  const b = appendMessage(s, 'B')
  header(s, 'left')
  end(s, 2)
  s.append('compaction/start', { turn: null, compactionId: 'left' })
  s.append('compaction/summary', { compactionId: 'left', shadowedRange: { start: a, end: b }, shadowedSeqs: [a, b] })
  s.append('user/message', message('AB摘要'), { surfaceOp: { op: 'replace', startSeq: a, endSeq: b }, sourceEventSeqs: [a, b] })
  const compactB = s.append('compaction/end', { turn: null, compactionId: 'left' }).seq
  assert.deepEqual(textOf(s), ['AB摘要'])
  s.append('turn/start', { turn: 3, parentSeq: endA })
  assert.deepEqual(textOf(s), ['A'])
  assert.equal(s.requestContext().model, 'base')
  assert.equal(s.requestHeader().config.model, 'base')
  assert.equal(s.toolHistory().tools[0].name, 'base')
  const c = appendMessage(s, 'C')
  end(s, 3)
  s.append('compaction/start', { turn: null, compactionId: 'right' })
  assert.throws(() => s.append('compaction/summary', { compactionId: 'right', shadowedRange: { start: b, end: c }, shadowedSeqs: [b, c] }), /跨度/)
  s.append('compaction/summary', { compactionId: 'right', shadowedRange: { start: a, end: c }, shadowedSeqs: [a, c] })
  // Physical A was already shadowed by AB. Only the selected branch can admit this rewrite.
  s.append('user/message', message('AC摘要'), { surfaceOp: { op: 'replace', startSeq: a, endSeq: c }, sourceEventSeqs: [a, c] })
  s.append('compaction/end', { turn: null, compactionId: 'right' })
  assert.deepEqual(textOf(s), ['AC摘要'])
  const before = s.seq
  assert.throws(() => s.append([['turn/start', { turn: 4, parentSeq: compactB }],
    ['user/message', message('bad'), { surfaceOp: 'append', sourceEventSeqs: [c] }]]), /其他分支/)
  assert.equal(s.seq, before)
  s.append([['turn/start', { turn: 4, parentSeq: compactB }], ['user/message', message('D'), { surfaceOp: 'append' }]])
  end(s, 4)
  assert.deepEqual(textOf(s), ['AB摘要', 'D'])
  assert.deepEqual(seen[2], ['A'])
  const cold = await context()
  const revived = cold.sessions.create(s.id, { meta: s.header, seed: s.snapshotEvents() })
  assert.ok(revived instanceof Session)
  assert.equal(revived.pathGeneration, s.pathGeneration)
  assert.deepEqual(textOf(revived), textOf(s))
  assert.deepEqual(revived.snapshotEvents(0, s.seq), s.snapshotEvents())
  const disk = encodeTreeRows(s.snapshotEvents())
  assert.ok(disk.some(e => e.type === 'plugin:study-tree/replacement'))
  assert.deepEqual(decodeTreeRows(disk), s.snapshotEvents())
  assertReleasedV4Relationships({ header: s.header, inheritedEventCount: 0, events: disk }, KNOWN_SESSION_EVENT_TYPES)
  assert.deepEqual(activePathEvents(s.snapshotEvents()), s.activePathEvents())
  assert.equal(revived.toolHistory().tools[0].name, 'left')
  assert.equal(revived.requestContext().model, 'left')
  assert.equal(revived.completedTurnBoundary(2), compactB)
  appendPluginRecord(revived, 'plugin:other/state', { after: 'resume' })
  assert.equal(revived.snapshotEvents().at(-1).data.after, 'resume')
})

test('根和父边界按原生请求编号分配，延迟答复在恢复后仍归提问回合', async () => {
  const ctx = await context()
  const plain = ctx.sessions.create('plain'), initial = plain.surface
  const source = message('普通问题', 'plain')
  assert.equal(routeTreeInput(plain, source), source)
  assert.equal(plain.surface, initial)
  assert.deepEqual(treePath(plain), [])
  const s = ctx.sessions.create('tree')
  const agent = { session: s, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  const request = (requestId, parentSeq) => ({ sessionId: s.id, requestId, parentSeq, metadata: { studyTree: { id: crypto.randomUUID() } } })
  const root = request('A', null)
  prepareTreePrompt(ctx, agent, root)
  prepareTreePrompt(ctx, agent, root)
  const routed = id => routeTreeInput(s, message(id, id)).turnParent
  s.append('turn/start', { turn: 1, ...routed('A') })
  const endA = end(s, 1)
  const left = request('B', endA), right = request('C', endA)
  prepareTreePrompt(ctx, agent, left)
  prepareTreePrompt(ctx, agent, right)
  assert.throws(() => prepareTreePrompt(ctx, agent, { ...left, parentSeq: 999 }), /请求编号/)
  assert.deepEqual(routed('C').metadata, right.metadata)
  s.append('turn/start', { turn: 2, ...routed('B') })
  s.append('tool/call', { turn: 2, step: 1, name: 'ask_user_question', callId: 'q', arguments: '{}' })
  const endB = end(s, 2)
  s.append('turn/start', { turn: 3, ...routed('C') })
  end(s, 3)
  const cold = await context()
  const revived = cold.sessions.create(s.id, { meta: s.header, seed: s.snapshotEvents() })
  const reply = createUserMessage({ source: { kind: 'user-question-reply', callId: 'q' }, content: [{ type: 'text', text: '答复' }] })
  const { continuationOf } = routeTreeInput(revived, reply).turnParent
  assert.equal(continuationOf, 2)
  assert.equal(revived.continuationBoundary(continuationOf), endB)
  revived.append('turn/start', { turn: 4, continuationOf, parentSeq: endB })
  const tail = end(revived, 4)
  assert.equal(revived.continuationBoundary(continuationOf), tail)
  assert.equal(treePath(revived).some(e => e.type === 'turn/start' && e.data.turn === 3), false)
  assert.equal(plain.isTree, undefined)
  assert.equal(plain.surface, initial)
})

test('准备请求沿用当前调用者的原生发言权限，拒绝时不会唤醒会话或写入树标记', async () => {
  const ctx = await context(), session = ctx.sessions.create('locked')
  const request = { sessionId: session.id, requestId: 'ask', parentSeq: null, metadata: { studyTree: { id: crypto.randomUUID() } } }
  const agent = { session, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  let reached = 0, granted = false, revokeOnResolve = false, last
  ctx.provide('remoteAccess', { decide(input) { last = input; return granted ? { kind: 'allow' } : { kind: 'deny', reason: 'read-only' } } })
  ctx.provide('sessionController', { async resolveAgent() {
    reached++
    if (revokeOnResolve) granted = false
    return { agent }
  } })
  ctx.provide('storageDomain', { open: async () => ({ table: () => new Map(), close() {} }) })
  ctx.provide('typert', { register() {}, lookups: { register() {} } })
  await mountStudyTree(ctx)
  const principal = { kind: 'viewer', id: 'reader' }
  const remote = ctx.extend({ invocation: { peer: { principal }, request: { namespace: 'studyTree', method: 'preparePrompt' } } }).get('studyTree')
  await assert.rejects(remote.preparePrompt(request), { code: 'remote-access/denied' })
  assert.equal(reached, 0)
  assert.deepEqual(last.resources, [{ kind: 'session', id: 'locked' }])
  assert.equal(last.action, 'session/prompt')
  granted = revokeOnResolve = true
  await assert.rejects(remote.preparePrompt(request), { code: 'remote-access/denied' })
  assert.equal(reached, 1)
  assert.equal(session.seq, 0)
  granted = true
  revokeOnResolve = false
  await remote.preparePrompt(request)
  assert.equal(session.isTree, undefined)
  assert.equal(routeTreeInput(session, message('A', request.requestId)).turnParent.requestId, request.requestId)
  assert.equal(session.isTree, true)
})

test('取消准备或准备后重启不会把无关的普通消息声明为学习树根节点', async () => {
  const ctx = await context(), s = ctx.sessions.create('empty')
  const request = { sessionId: s.id, requestId: 'cancelled', parentSeq: null, metadata: { studyTree: { id: crypto.randomUUID() } } }
  prepareTreePrompt(ctx, { session: s, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }, request)
  const cold = await context(), recovered = cold.sessions.create(s.id, { meta: s.header, seed: s.snapshotEvents() })
  const ordinary = message('普通消息', 'ordinary')
  assert.equal(routeTreeInput(recovered, ordinary), ordinary)
  recovered.append('turn/start', { turn: 1 })
  end(recovered, 1)
  assert.throws(() => routeTreeInput(recovered, message('过期的根', request.requestId)), /首个回合/)
  assert.equal(recovered.isTree, undefined)
  assert.equal(recovered.snapshotEvents().some(e => e.type === 'plugin:study-tree/tree'), false)
})
