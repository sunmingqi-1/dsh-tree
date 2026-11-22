import { Ancestry, isTreeMarker } from './ancestry.js'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

// The rc.5 native fold requires contiguous global sequence numbers. Empty
// positions retain only a sequence, never sibling content or request headers.
const masked = seq => ({ seq, time: 0, type: 'plugin:study-tree/inactive', ignorable: true, data: {} })
const checkpoint = event => event.type === 'user/message' && event.surfaceOp?.op === 'replace'
  && event.data.source?.kind === 'compact-checkpoint'
const lifecycle = event => isTreeMarker(event) || event.type.startsWith('compaction/') || checkpoint(event)
  || ['turn/start', 'turn/end', 'session/end-seed'].includes(event.type)

// rc.5 validates a compaction against the surface at its own position. Its
// physical reader skips our ignorable rows, so enforce that contract here
// against the native fold of the actual branch, on both append and restore.
function nextCompaction(current, event, index, native, window) {
  const { type, data } = event
  if (type === 'session/end-seed') return undefined
  if (type === 'compaction/start') {
    if (current || data.turn !== index.open || typeof data.compactionId !== 'string' || !data.compactionId)
      throw new Error('学习树压缩的开始记录无效')
    return { id: data.compactionId, command: data.sourceCommandId, turn: data.turn, summarized: false }
  }
  if (type === 'compaction/summary' || type === 'compaction/prune') {
    const nodes = native.nodes
    const first = nodes.indexOf(data.shadowedRange?.start)
    const last = nodes.indexOf(data.shadowedRange?.end)
    if (first < 0 || last < first || !Array.isArray(data.shadowedSeqs) || data.shadowedSeqs.length !== last - first + 1
      || data.shadowedSeqs.some((seq, i) => nodes[first + i] !== seq)
      || (first === 0 && window[nodes[0]]?.type === 'system/message')) throw new Error('学习树压缩跨度与所选分支不一致')
  }
  if (type === 'compaction/summary' || type === 'compaction/end' || checkpoint(event)) {
    const owner = checkpoint(event) ? data.source : data
    if (!current || current.id !== owner.compactionId || current.command !== owner.sourceCommandId || current.turn !== index.open)
      throw new Error('学习树压缩记录与正在执行的压缩不一致')
    if (type === 'compaction/summary') {
      if (current.summarized) throw new Error('学习树压缩重复记录了摘要')
      return { ...current, summarized: true }
    }
    if (type === 'compaction/end') {
      if (current.turn !== data.turn || (data.error === undefined && !current.summarized))
        throw new Error('学习树压缩成功前必须记录摘要')
      return undefined
    }
  }
  return current
}

export class BranchSurface {
  index = new Ancestry()
  window = []
  replaceOffset = 0
  contentOffset = 0
  pending = null
  compaction = undefined

  constructor(physical, NativeSurface, projections) {
    this.physical = physical
    this.NativeSurface = NativeSurface
    this.projections = projections
    this.native = new NativeSurface(this.window, 0, projections)
  }

  checkSources(event, window) {
    if (event.sourceEventSeqs?.some(seq => window[seq]?.type === 'plugin:study-tree/inactive'))
      throw new Error('消息替换引用了其他分支的事件')
  }

  stage(event, physical = this.physical) {
    const update = this.index.plan(event)
    let { native, window } = this
    let replaceOffset = this.replaceOffset, contentOffset = this.contentOffset
    if (update?.jump !== undefined) {
      window = Array.from({ length: event.seq }, (_, seq) => masked(seq))
      for (const seq of this.index.path(update.jump)) window[seq] = physical[seq]
      native = new this.NativeSurface(window, 0, this.projections)
      replaceOffset += this.native.replaceGeneration + 1 - native.replaceGeneration
      contentOffset += this.native.contentGeneration + 1 - native.contentGeneration
    }
    this.checkSources(event, window)
    const compaction = this.index.declared && lifecycle(event)
      ? nextCompaction(this.compaction, event, this.index, native, window) : this.compaction
    native.validateNext(event)
    return () => {
      update?.apply()
      this.window = window
      this.native = native
      this.replaceOffset = replaceOffset
      this.contentOffset = contentOffset
      this.compaction = compaction
      window.push(event)
    }
  }

  sync() {
    while (this.window.length < this.physical.length) {
      const event = this.physical[this.window.length]
      const commit = this.pending?.event === event ? this.pending.commit : this.stage(event)
      this.pending = null
      commit()
    }
  }

  validateNext(event) {
    this.sync()
    this.pending = { event, commit: this.stage(event) }
  }

  prepareBatch(events) {
    this.sync()
    if (!events.some(lifecycle)) {
      for (const event of events) this.checkSources(event, this.window)
      const accept = this.native.prepareBatch(events)
      return () => {
        for (const event of events) this.window.push(event)
        accept()
        this.pending = null
      }
    }
    const staged = new BranchSurface(this.physical, this.NativeSurface, this.projections)
    staged.index = this.index.copy()
    staged.window = this.window.slice()
    staged.native = new this.NativeSurface(staged.window, 0, this.projections)
    staged.contentOffset = this.contentOffset
    staged.replaceOffset = this.replaceOffset
    staged.compaction = this.compaction
    const physical = [...this.physical, ...events]
    for (const event of events) staged.stage(event, physical)()
    return () => { Object.assign(this, staged) }
  }

  get nodes() { this.sync(); return this.native.nodes }
  get replaceGeneration() { this.sync(); return this.replaceOffset + this.native.replaceGeneration }
  get contentGeneration() { this.sync(); return this.contentOffset + this.native.contentGeneration }
  deriveEventMessage(event) { this.sync(); return this.native.deriveEventMessage(event) }
}

// The pinned rc.5 Session owns its actual write attachment and #appendRecord
// private brand. Adapt only this Session; the prototype and store stay native.
export function installTreeSurface(session, projections) {
  if (session.surface instanceof BranchSurface) return
  if (!Array.isArray(session.log) || session.surfaceManager !== session.surface
    || typeof session.surface?.constructor !== 'function' || typeof session.surface?.prepareBatch !== 'function'
    || typeof session.toolHistoryProjection?.apply !== 'function') {
    throw new Error('学习树无法装配会话，请检查 DeepSeek Harness 0.2.2-rc.5 版本')
  }
  const surface = new BranchSurface(session.log, session.surface.constructor, projections)
  surface.sync()
  const index = () => { surface.sync(); return surface.index }
  Object.defineProperties(session, {
    isTree: { get() { return index().declared } },
    pathGeneration: { get() { return index().jumps.size } },
  })
  session.surfaceManager = surface
  session.isTurnBoundary = seq => index().boundaries.has(seq)
  session.completedTurnBoundary = turn => index().ends.get(turn)
  session.continuationBoundary = turn => index().continuation(turn)
  session.pathSwitchedAt = seq => index().jumps.has(seq)
  let pathSnapshot
  session.activePathEvents = (end = session.seq - 1) => {
    if (end === -1 && !session.seq) return Object.freeze([])
    if (!Number.isSafeInteger(end) || end < 0 || end >= session.seq) throw new Error('学习树日志位置不存在')
    if (end === session.seq - 1 && pathSnapshot?.at(-1)?.seq === end) return pathSnapshot
    const path = Object.freeze(index().path(end).map(seq => session.log[seq]))
    if (end === session.seq - 1) pathSnapshot = path
    return path
  }

  // Preserve the official tool-declaration interpreter and rebuild the header,
  // route and tool baselines together when their common ancestor changes.
  const ToolHistory = session.toolHistoryProjection.constructor
  let generation = -1, offset = 0, header, context, tools
  function updateRequest() {
    const active = index()
    let events
    if (generation !== active.jumps.size) {
      generation = active.jumps.size
      header = context = undefined
      tools = new ToolHistory()
      events = session.activePathEvents()
    } else {
      if (offset === session.seq) return
      events = session.snapshotEvents(offset)
    }
    for (const event of events) {
      if (event.type === 'request/header') header = deepFreeze(canonicalHeader(event.data.header))
      if (event.type === 'request/context') context = deepFreeze({ ...event.data })
      tools.apply(event)
    }
    offset = session.seq
  }
  session.requestHeader = () => { updateRequest(); return header }
  session.requestContext = () => { updateRequest(); return context }
  session.toolHistory = () => { updateRequest(); return tools.snapshot() }
}
