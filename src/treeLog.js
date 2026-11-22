/** Fold the durable tree log once in global sequence order. Keep only card metadata. */
export class TreeLog {
  nodes = new Map()
  boundaries = new Map()
  nextSeq = 0
  marked = false
  rootId = null
  opening = null
  current = null
  lastClosed = null
  completedCard = null
  idleCompaction = null
  queued = []

  constructor(sessionId) { this.sessionId = sessionId }

  append(event) {
    const { type, seq, data } = event
    this.nextSeq = seq + 1
    if (type === 'session/tree' || (type === 'plugin:study-tree/tree' && event.ignorable === true)) this.marked = true
    if (!this.marked) return
    if (type === 'agent/inbox/spliced' && data.target === 'next-turn') {
      this.queued.splice(data.start, data.removedCount || 0, ...data.inserted)
    } else if (type === 'turn/start') {
      this.idleCompaction = null
      this.opening = event
      this.current = null
      const admitted = this.queued.find(item => data.requestId && item.source?.rpcId === data.requestId)
      if (admitted) return this.addQuestion(admitted)
      const parent = this.boundaries.get(data.parentSeq)
      if (!data.requestId && parent && typeof data.parentSeq === 'number') {
        const latest = this.nodes.get(parent.id)
        const next = { turn: data.turn, startSeq: seq }
        this.current = { ...latest, status: 'sending', error: null, endSeq: null,
          activeTurns: [...(parent.activeTurns || [parent.turn]), next.turn],
          continuations: [...(latest.continuations || []), next] }
        this.nodes.set(parent.id, this.current)
        return this.current
      }
    } else if (type === 'user/message' && this.opening && !this.current) {
      return this.addQuestion(data)
    } else if (type === 'compaction/start' && data.turn === null && !this.opening) {
      this.idleCompaction = data.compactionId
    } else if (type === 'session/end-seed') {
      this.idleCompaction = null
    } else if (type === 'compaction/end' && data.turn === null && data.compactionId && data.compactionId === this.idleCompaction) {
      this.idleCompaction = null
      if (typeof data.error !== 'undefined') return
      if (!this.completedCard) {
        this.boundaries.set(seq, this.lastClosed)
        return
      }
      const node = { ...this.completedCard, boundarySeq: seq }
      this.nodes.set(node.id, node)
      this.boundaries.set(seq, node)
      this.lastClosed = this.completedCard = node
      return node
    } else if (type === 'turn/end' && this.opening?.data.turn === data.turn) {
      const parentSeq = this.opening.data.parentSeq
      this.opening = null
      this.completedCard = null
      if (!this.current) {
        if (parentSeq !== undefined) this.lastClosed = this.boundaries.get(parentSeq) ?? null
        this.boundaries.set(seq, this.lastClosed)
        return
      }
      const { kind } = data.reason
      const status = kind === 'completed' ? 'complete' : kind === 'aborted' ? 'stopped' : 'failed'
      const node = { ...this.current, endSeq: seq, boundarySeq: seq, status,
        error: status === 'failed' ? data.reason.error?.message || data.reason.message || '本轮生成未完成' : null }
      this.nodes.set(node.id, node)
      this.boundaries.set(seq, node)
      this.lastClosed = this.completedCard = node
      this.current = null
      return node
    }
  }

  addQuestion(data) {
    const start = this.opening.data
    const source = data.source
    if (!source?.rpcId || source.kind && source.kind !== 'user' || start.requestId && start.requestId !== source.rpcId) return
    const meta = start.metadata?.studyTree || {}
    const parent = start.parentSeq === undefined ? this.lastClosed : this.boundaries.get(start.parentSeq)
    if (!parent && this.rootId !== null) return
    const id = typeof meta.id === 'string' ? meta.id : this.sessionId + '/' + start.turn
    this.rootId ??= id
    const text = data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    const { question, anchor } = nativeQuestion(text, meta.anchor)
    this.current = {
      id, treeId: this.rootId, parentId: parent?.id || null, question, anchor,
      created: this.opening.time, sessionId: this.sessionId, requestId: source.rpcId,
      endSeq: null, boundarySeq: null, status: 'sending', error: null, revision: 0,
      ...(parent && { parentTurns: parent.activeTurns || [parent.turn] }),
      turn: start.turn, startSeq: this.opening.seq, logged: true,
      ...(typeof meta.versionOf === 'string' && { versionOf: meta.versionOf }),
    }
    this.nodes.set(id, this.current)
    return this.current

  }
}

export const quoteText = text => text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n')

export function nativeQuestion(text, anchor) {
  const quote = typeof anchor?.text === 'string' && quoteText(anchor.text)
  const linked = quote && text.includes(quote) ? anchor : null
  const question = (linked ? text.replace(quote, '') : text).trim()
  return { question: question || (linked ? '解释这段内容' : '阅读附件'), anchor: linked }
}
