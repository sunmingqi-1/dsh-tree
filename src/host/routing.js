import { isDeepStrictEqual } from 'node:util'
import { PROMPT_RECORD } from './ancestry.js'

const indexes = new WeakMap()

// Inboxes and tool replies are session-wide, including inactive sibling turns.
// Index the physical stream and recover exactly the same ownership on restart.
function routes(session) {
  let state = indexes.get(session)
  if (!state) {
    state = { offset: 0, prepared: new Map(), calls: new Map(), turn: null, started: false, queuedTurns: 0 }
    indexes.set(session, state)
  }
  if (state.offset === session.seq) return state
  for (const event of session.snapshotEvents(state.offset)) {
    const { type, data } = event
    if (type === PROMPT_RECORD && event.ignorable === true) state.prepared.set(data.requestId, data)
    if (type === 'turn/start') {
      state.turn = data.turn
      state.started = true
      state.queuedTurns = 0
    }
    if (!state.started && type === 'agent/inbox/spliced' && data.target === 'next-turn')
      state.queuedTurns += data.inserted.length - (data.removedCount ?? 0)
    if (type === 'turn/end') state.turn = null
    if (type === 'tool/call') state.calls.set(data.callId, data.turn)
    if (type === 'tool/ptc-dispatch' && state.turn !== null) state.calls.set(data.subCallId, state.turn)
    state.offset = event.seq + 1
  }
  return state
}

export function treePath(session) {
  return session.activePathEvents?.() ?? session.snapshotEvents()
}

export function prepareTreePrompt(ctx, agent, request) {
  const { session } = agent
  const { sessionId, ...intent } = request
  const state = routes(session)
  if (session.id !== sessionId || ctx.sessions.get(sessionId) !== session) throw new Error('学习树会话已关闭')
  const before = state.prepared.get(intent.requestId)
  if (before) {
    if (!isDeepStrictEqual(before, intent)) throw new Error('请求编号已绑定到另一学习树节点')
    return
  }
  if (intent.parentSeq === null) {
    if (agent.status !== 'idle' || state.started || agent.inbox.nextTurn.length
      || agent.inbox.nextStep.some(item => item.source?.kind === 'user')) throw new Error('根节点需要新的空会话')
    ctx.sessions.armStudyTree(session)
  } else if (!session.isTree || !session.isTurnBoundary(intent.parentSeq)) {
    throw new Error('父节点尚未完成或不属于此学习树')
  }
  ctx.sessions.recordStudyTree(session, PROMPT_RECORD, intent)
}

export function routeTreeInput(session, message) {
  if (message.turnParent !== undefined) return message
  const source = message.source
  if (!session.isTree && (!session.admitStudyTreeRoot || source?.kind !== 'user')) return message
  const state = routes(session)
  if (source?.kind === 'user') {
    const prepared = state.prepared.get(source.rpcId)
    if (prepared) {
      if (prepared.parentSeq === null) {
        if (state.started || state.queuedTurns > 0) throw new Error('学习树根节点需要独占首个回合')
        if (!session.isTree) session.admitStudyTreeRoot()
      }
      return { ...message, turnParent: prepared }
    }
    if (session.isTree && !state.started) throw new Error('请先从学习树提交根节点')
  }
  if (source?.kind === 'user-question-reply') {
    const origin = state.calls.get(source.callId)
    if (origin === undefined) throw new Error('找不到延迟答复的原始学习树回合')
    return { ...message, turnParent: { continuationOf: origin } }
  }
  return message
}
