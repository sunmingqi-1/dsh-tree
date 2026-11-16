import { readTurn, type Turn, type Anchor } from './tree'
export class Study {
  nodes: Turn[] = []
  answers = new Map<string, string>()
  issues = new Map<string, string>()
  listeners = new Set<() => void>()
  watches = new Map<string, () => void>()
  closing = false
  loaded = false
  error = ''
  constructor(readonly ctx) {}
  emit() {
    for (const f of this.listeners) f()
  }
  async call(method, args = {}) {
    const r = await this.ctx.connection.rpc.call('/api', 'studyTree/' + method, { args })
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  async refresh() {
    const [rows] = await Promise.all([this.call('list'), this.ctx.sessions.refresh()])
    for (const row of rows) this.merge(row)
    this.issues.clear()
    this.loaded = true
    this.error = ''
    this.emit()
  }
  merge(node: Turn) {
    const prev = this.nodes.find((n) => n.id === node.id)
    if (!prev) this.nodes = [...this.nodes, node]
    else if (prev.revision < node.revision)
      this.nodes = this.nodes.map((n) => (n.id === node.id ? node : n))
  }
  async save(n: Turn) {
    const saved = await this.call('save', { request: n })
    this.merge(saved)
    this.emit()
    return saved as Turn
  }
  async submit(
    parent: Turn | null,
    question: string,
    anchor: Anchor | null,
    select,
    versionOf?: string,
  ) {
    if (parent && (parent.endSeq == null || !parent.sessionId))
      throw new Error('请等待来源回答结束')
    const id = crypto.randomUUID()
    let n = await this.save({
      id,
      treeId: parent?.treeId || id,
      parentId: parent?.id || null,
      question,
      anchor,
      versionOf,
      created: Date.now(),
      sessionId: null,
      requestId: null,
      endSeq: null,
      status: 'preparing',
      error: null,
      revision: 0,
    })
    select(n)
    let sending = false
    let handle
    try {
      const sessionId = parent
        ? await this.ctx.sessions.fork({ sessionId: parent.sessionId, atSeq: parent.endSeq })
        : await this.ctx.sessions.create()
      n = await this.save({ ...n, sessionId })
      await this.ctx.sessions.using(sessionId, { source: 'studyTree' }, async (ref) => {
        const { session } = await ref.ready
        const text = anchor ? '原文引用：\n' + anchor.text + '\n\n' + question : question
        handle = session.beginSubmission({ text, mode: 'queue', attachments: [] })
        n = await this.save({ ...n, requestId: handle.requestId, status: 'sending' })
        this.watch(n)
        sending = true
        const result = await session.prompt(
          [{ type: 'text', text }],
          'queue',
          undefined,
          handle.requestId,
        )
        if (!result.ok) {
          sending = false
          throw new Error(result.error.message)
        }
      })
    } catch (e) {
      if (!sending) handle?.abandon()
      const latest = this.nodes.find((item) => item.id === id) || n
      const createdSession = e.rpcError?.code === 'session/workspace-attach-failed'
        ? e.rpcError.details?.sessionId
        : undefined
      if (latest.endSeq === null)
        await this.save({
          ...latest,
          sessionId: latest.sessionId ?? createdSession ?? null,
          status: sending ? 'sending' : 'failed',
          error: String(e.message || e),
        })
      throw e
    }
  }
  watch(n: Turn) {
    if (
      this.closing ||
      !n.sessionId ||
      !n.requestId ||
      (n.status === 'failed' && n.endSeq === null) ||
      this.watches.has(n.id) ||
      (this.answers.has(n.id) && n.endSeq !== null)
    )
      return
    let ref
    try {
      ref = this.ctx.sessions.retain(n.sessionId, { source: 'studyTree' })
    } catch (e) {
      this.issues.set(n.id, '无法打开来源会话：' + e.message)
      this.emit()
      return
    }
    let off = () => {},
      stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      off()
      ref.release()
      this.watches.delete(n.id)
    }
    this.watches.set(n.id, stop)
    const fail = (e) => {
      stop()
      this.issues.set(n.id, String(e.message || e))
      this.emit()
    }
    void ref.ready
      .then(async (binding) => {
        if (stopped) return
        const parent = this.nodes.find((row) => row.id === n.parentId)
        await binding.session.loadThrough(parent?.endSeq ?? 0)
        if (stopped) return
        let finishing = false
        const read = () => {
          if (stopped || finishing) return
          const result = readTurn(binding.eventSource.getSnapshot().entries, n.requestId)
          this.answers.set(n.id, result.answer)
          this.issues.delete(n.id)
          if (result.endSeq !== null) {
            finishing = true
            const status =
              result.reason.kind === 'completed'
                ? 'complete'
                : result.reason.kind === 'aborted'
                  ? 'stopped'
                  : 'failed'
            if (n.endSeq === result.endSeq) stop()
            else
              void this.save({
                ...n,
                endSeq: result.endSeq,
                status,
                error: status === 'failed' ? result.reason.message || '本轮生成失败' : null,
              }).then(stop, async (e) => {
                stop()
                try {
                  await this.refresh()
                } catch {
                  fail(e)
                }
              })
          }
          this.emit()
        }
        off = binding.eventSource.subscribe(read)
        read()
      })
      .catch(fail)
  }
  dispose() {
    this.closing = true
    for (const stop of [...this.watches.values()]) stop()
    this.listeners.clear()
  }
}
