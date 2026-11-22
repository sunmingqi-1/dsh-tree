// A boundary always names a position in the one physical, append-only log.
export const TREE_MARKER = 'plugin:study-tree/tree'
export const PROMPT_RECORD = 'plugin:study-tree/prompt'
export const isTreeMarker = e => e.type === 'session/tree' || (e.type === TREE_MARKER && e.ignorable === true)

export function activePathEvents(events, end = events.at(-1)?.seq) {
  if (end === undefined) return Object.freeze([])
  if (events[end]?.seq !== end) throw new Error('学习树恢复需要从零开始的完整日志')
  const index = new Ancestry()
  for (let seq = 0; seq <= end; seq++) {
    if (events[seq]?.seq !== seq) throw new Error('学习树日志序号不连续')
    index.plan(events[seq])?.apply()
  }
  return Object.freeze(index.path(end).map(seq => events[seq]))
}

// Format v4's linear validator cannot interpret branch-relative replacement
// ranges. A v4 reader still owns all ordinary native rows and can retain these
// ignorable, plugin-owned rows without assigning them a different sequence.
const REPLACEMENT = 'plugin:study-tree/replacement'
const compact = new Set(['compaction/start', 'compaction/prune', 'compaction/summary', 'compaction/end'])
const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const branchRecord = e => compact.has(e.type) || (surfaceTypes.has(e.type) && e.surfaceOp?.op === 'replace')

export function encodeTreeRows(events, alreadyTree = false) {
  let tree = alreadyTree
  return events.map(event => {
    if (isTreeMarker(event)) tree = true
    if (!tree || !branchRecord(event)) return event
    const { seq, time, ...data } = event
    return { type: REPLACEMENT, seq, time, ignorable: true, data }
  })
}

export function decodeTreeRows(events) {
  let tree = false
  return events.map(row => {
    if (isTreeMarker(row)) tree = true
    if (!tree || row.type !== REPLACEMENT || !row.ignorable) return row
    const event = { ...row.data, seq: row.seq, time: row.time }
    if (!branchRecord(event) || !Object.hasOwn(event, 'data')) throw new Error('学习树压缩日志损坏')
    return event
  })
}

export class Ancestry {
  declared = false
  started = false
  open = null
  idleCompaction = null
  lastTurn = null
  lastBoundary = null
  boundaries = new Set()
  ends = new Map()
  owners = new Map()
  tails = new Map()
  jumps = new Map()

  copy() {
    const copy = Object.assign(new Ancestry(), this)
    for (const key of ['ends', 'owners', 'tails', 'jumps']) copy[key] = new Map(this[key])
    copy.boundaries = new Set(this.boundaries)
    return copy
  }

  continuation(turn) {
    const owner = this.owners.get(turn) ?? turn
    return this.tails.get(owner) ?? this.ends.get(owner)
  }

  path(end) {
    const path = []
    for (let seq = end; seq >= 0; seq = this.jumps.get(seq) ?? seq - 1) path.push(seq)
    return path.reverse()
  }

  // Validate before the native Session announces its event. Apply only after commit.
  plan(event) {
    const { data, seq, type } = event
    if (isTreeMarker(event)) {
      if (this.declared || this.started) throw new Error('学习树必须在第一个回合之前声明')
      return { apply: () => { this.declared = true } }
    }
    if (type === 'turn/start') {
      const { turn, parentSeq, continuationOf } = data
      if (!this.declared) return { apply: () => { this.started = true } }
      if (!Number.isSafeInteger(turn) || turn < 0 || this.open !== null || this.ends.has(turn))
        throw new Error('学习树回合编号或关闭状态无效')
      if ((!this.started) !== (parentSeq === null)) throw new Error('只有首个学习树回合可以使用空父节点')
      if (parentSeq != null && !this.boundaries.has(parentSeq)) throw new Error('学习树父边界无效')
      if (continuationOf !== undefined && (data.requestId !== undefined || parentSeq == null
        || this.continuation(continuationOf) !== parentSeq)) throw new Error('学习树延迟回复来源无效')
      const jump = parentSeq != null && parentSeq !== this.lastBoundary ? parentSeq : undefined
      return { jump, apply: () => {
        this.started = true
        this.open = turn
        this.idleCompaction = null
        if (jump !== undefined) this.jumps.set(seq, jump)
        if (continuationOf !== undefined) this.owners.set(turn, this.owners.get(continuationOf) ?? continuationOf)
      } }
    }
    if (!this.declared) return
    if (type === 'turn/end') {
      if (this.open !== data.turn) throw new Error('学习树回合结束记录与打开的回合不一致')
      return { apply: () => {
        this.open = null
        this.lastTurn = data.turn
        this.closeAt(seq)
      } }
    }
    if (type === 'session/end-seed') return { apply: () => { this.idleCompaction = null } }
    if (this.open !== null || this.lastTurn === null || data?.turn !== null || typeof data.compactionId !== 'string') return
    if (type === 'compaction/start') return { apply: () => { this.idleCompaction = data.compactionId } }
    if (type === 'compaction/end' && this.idleCompaction === data.compactionId) return { apply: () => {
      this.idleCompaction = null
      if (!('error' in data)) this.closeAt(seq)
    } }
  }

  closeAt(seq) {
    this.lastBoundary = seq
    this.boundaries.add(seq)
    this.ends.set(this.lastTurn, seq)
    const owner = this.owners.get(this.lastTurn)
    if (owner !== undefined) this.tails.set(owner, seq)
  }
}
