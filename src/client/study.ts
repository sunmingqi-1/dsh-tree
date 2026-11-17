import { readTurn, isUserPrompt, type Turn, type Anchor } from './tree'
import { NativeDrafts } from './nativeDrafts'
import { NativeTurns, NativeInteractions } from './nativeState'
export class Study {
  composers = new NativeDrafts(this)
  turns = new NativeTurns()
  interactions = new NativeInteractions(this)
  private answerSources = new Map<string, any>()
  answerSource(id: string) {
    if (!this.answerSources.has(id)) {
      const listeners = new Set<() => void>()
      this.answerSources.set(id, {
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot: () => this.answers.get(id) || '',
        emit: () => { for (const listener of listeners) listener() },
      })
    }
    return this.answerSources.get(id)
  }
  version = 0
  enabled = false
  creating = false
  pendingSession: string | null = null
  pendingStop = () => {}
  nativeTarget: string | null = null
  readerTarget: { parentId: string; sessionId: string } | null = null
  readerDrafts = (() => {
    try {
      return JSON.parse(localStorage.getItem('dsh-study-tree:reader-drafts') || '{}')
    } catch {
      return {}
    }
  })()
  private nativePending = new Set<string>()
  active: string | null = null
  navigation: { id: string | null; revision: number } | null = null
  workspaceId: string | undefined
  turnNumbers = new Map<string, number>()
  nodes: Turn[] = []
  answers = new Map<string, string>()
  issues = new Map<string, string>()
  listeners = new Set<() => void>()
  watches = new Map<string, () => void>()
  private historyQueue: Turn[] = []
  private reading = new Set<string>()
  closing = false
  loaded = false
  error = ''
  constructor(readonly ctx) {}
  workspaceFor(sessionId) {
    return this.ctx.workspaces.list
      .getSnapshot()
      .items.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId
  }
  startNew(workspaceId = this.workspaceId) {
    this.enabled = false
    this.creating = true
    this.pendingStop()
    this.pendingSession = null
    this.workspaceId = workspaceId
    this.ctx.uiWorkspace.startSession(workspaceId)
    this.emit()
  }
  armRoot(sessionId) {
    if (this.pendingSession === sessionId) return
    this.pendingStop()
    this.pendingSession = sessionId
    this.creating = true
    const reference = this.ctx.sessions.retain(sessionId, { source: 'studyTree' })
    let off = () => {}
    let stopped = false
    let saving = false
    const id = crypto.randomUUID()
    this.pendingStop = () => {
      stopped = true
      off()
      reference.release()
      this.pendingSession = null
    }
    reference.ready
      .then((binding) => {
        if (stopped) return
        const read = async () => {
          if (saving || stopped) return
          const message = binding.eventSource
            .getSnapshot()
            .entries.find(
              ({ event }) => isUserPrompt(event),
            )?.event
          if (!message) return
          saving = true
          try {
            const question =
              message.data.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n') || '阅读附件'
            const node =
              this.nodes.find((item) => item.id === id) ||
              (await this.save({
                id,
                treeId: id,
                parentId: null,
                question,
                anchor: null,
                created: Date.now(),
                sessionId,
                requestId: message.data.source.rpcId,
                endSeq: null,
                status: 'sending',
                error: null,
                revision: 0,
              }))
            this.watch(node)
            if (!stopped) {
              this.creating = false
              this.pendingStop()
              this.open(node.id)
            }
          } catch (error) {
            saving = false
            this.error = error.message
            await this.refresh().catch(() => {})
            if (!stopped && this.nodes.some((item) => item.id === id)) void read()
            this.emit()
          }
        }
        off = binding.eventSource.subscribe(() => {
          void read()
        })
        void read()
      })
      .catch((error) => {
        this.error = error.message
        this.pendingStop()
        this.emit()
      })
    this.emit()
  }
  showSession(sessionId) {
    if (this.ctx.uiSession.adapter.current.getSnapshot().key === sessionId) {
      this.nativeTarget = null
      return
    }
    if (this.nativeTarget === sessionId) return
    this.nativeTarget = sessionId
    this.ctx.uiWorkspace.openSession(sessionId)
  }
  open(id: string | null) {
    if (!id) {
      this.startNew()
      return
    }
    const node = this.nodes.find((item) => item.id === id)
    if (!node) return
    const root = this.nodes.find((item) => item.id === node.treeId)
    this.workspaceId = this.workspaceFor(root?.sessionId)
    this.navigation = { id, revision: (this.navigation?.revision || 0) + 1 }
    this.active = id
    this.enabled = true
    if (node.sessionId) this.showSession(node.sessionId)
    this.emit()
  }
  emit() {
    this.version++
    for (const f of this.listeners) f()
  }
  async call(method, args = {}) {
    const r = await this.ctx.connection.rpc.call('/api', 'studyTree/' + method, { args })
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  refreshing: Promise<void> | null = null
  refresh() {
    if (!this.refreshing)
      this.refreshing = this.load().finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }
  private async load() {
    const [rows] = await Promise.all([this.call('list'), this.ctx.sessions.refresh()])
    const revisions = new Map(this.nodes.map((n) => [n.id, n]))
    for (const row of rows) {
      if ((revisions.get(row.id)?.revision ?? -1) < row.revision) revisions.set(row.id, row)
    }
    this.nodes = Array.from(revisions.values())
    this.issues.clear()
    this.loaded = true
    this.error = ''
    await this.composers.recover()
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
        ? await this.ctx.sessions.fork({
            sessionId: this.readerTarget?.parentId === parent.id
              ? this.readerTarget.sessionId : parent.sessionId,
            atSeq: parent.endSeq,
          })
        : await this.ctx.sessions.create({ workspaceId: this.workspaceId })
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
      const createdSession =
        e.rpcError?.code === 'session/workspace-attach-failed'
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
  // The restored native composer keeps its commands, attachments and submission
  // pipeline. Record messages it accepts as nodes rather than hiding new turns.
  // If this source already continued, give the native reader an exact-boundary
  // fork first so asking from an older card cannot inherit later descendants.
  followNative(parent: Turn) {
    let stopped = false,
      off = () => {},
      reference
    const start = async () => {
      this.readerTarget = null
      this.emit()
      let sessionId = this.readerDrafts[parent.id]
      if (!this.ctx.sessions.list.getSnapshot().byId[sessionId]) sessionId = parent.sessionId
      reference = this.ctx.sessions.retain(sessionId, { source: 'studyTree' })
      let binding = await reference.ready
      await binding.session.loadThrough(parent.endSeq)
      if (stopped) return
      const continued = this.nodes.some(n =>
        n.sessionId === sessionId && n.id !== parent.id && (n.endSeq ?? Infinity) > parent.endSeq,
      ) || binding.eventSource.getSnapshot().entries.some(({ event }) =>
        event.type === 'user/message' && event.seq > parent.endSeq,
      )
      if (continued) {
        sessionId = await this.ctx.sessions.fork({ sessionId, atSeq: parent.endSeq })
        this.readerDrafts[parent.id] = sessionId
        try {
          localStorage.setItem('dsh-study-tree:reader-drafts', JSON.stringify(this.readerDrafts))
        } catch {}
        if (stopped) return
        reference.release()
        reference = this.ctx.sessions.retain(sessionId, { source: 'studyTree' })
        binding = await reference.ready
        if (stopped) return
      }
      this.readerTarget = { parentId: parent.id, sessionId }
      this.showSession(sessionId)
      this.emit()
      const baseline = binding.eventSource.getSnapshot().entries.reduce(
        (seq, { event }) => Math.max(seq, event.seq), parent.endSeq,
      )
      const read = () => {
        if (stopped || !this.enabled) return
        const message = binding.eventSource.getSnapshot().entries.find(({ event }) =>
          isUserPrompt(event) && event.seq > baseline,
        )?.event
        if (!message || this.nodes.some(n => n.sessionId === sessionId && n.requestId === message.data.source.rpcId)) return
        const requestId = message.data.source.rpcId
        if (this.nativePending.has(requestId)) return
        this.nativePending.add(requestId)
        void this.save({
          id: crypto.randomUUID(),
          treeId: parent.treeId,
          parentId: parent.id,
          question: message.data.content.filter(p => p.type === 'text').map(p => p.text).join('\n') || '阅读附件',
          anchor: null,
          created: Date.now(),
          sessionId,
          requestId,
          endSeq: null,
          status: 'sending',
          error: null,
          revision: 0,
        })
          .then(node => {
            this.watch(node)
            if (!stopped) this.open(node.id)
          })
          .catch(error => {
            this.error = error.message
            this.emit()
          })
          .finally(() => this.nativePending.delete(requestId))
      }
      off = binding.eventSource.subscribe(read)
      read()
    }
    void start().catch(error => {
      if (!stopped) {
        this.error = error.message
        this.emit()
      }
    })
    return () => {
      stopped = true
      off()
      reference?.release()
    }
  }
  observe(turns: Turn[], path: Turn[]) {
    const wanted = new Set(turns.map((n) => n.id))
    this.historyQueue = []
    for (const id of this.reading) if (!wanted.has(id)) this.watches.get(id)?.()
    const ordered = new Map(
      [...path]
        .reverse()
        .concat(turns)
        .map((n) => [n.id, n]),
    )
    for (const n of ordered.values()) {
      if (!n.sessionId || !n.requestId || this.issues.has(n.id) || this.watches.has(n.id)) continue
      if (n.endSeq === null) this.watch(n)
      else if (!this.answers.has(n.id)) this.historyQueue.push(n)
    }
    this.drain()
  }
  private drain() {
    while (!this.closing && this.reading.size < 3 && this.historyQueue.length) {
      this.watch(this.historyQueue.shift()!)
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
    let timer: ReturnType<typeof setTimeout> | undefined
    if (n.endSeq !== null) this.reading.add(n.id)
    let off = () => {},
      stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      off()
      ref.release()
      this.watches.delete(n.id)
      if (this.reading.delete(n.id)) queueMicrotask(() => this.drain())
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
          const entries = binding.eventSource.getSnapshot().entries
          let turnNumber: number | undefined
          for (const { event } of entries) {
            if (event.type === 'turn/start') turnNumber = event.data.turn
            if (event.type === 'user/message' && event.data.source?.rpcId === n.requestId) {
              if (turnNumber !== undefined && this.turnNumbers.get(n.id) !== turnNumber) {
                this.turnNumbers.set(n.id, turnNumber)
                this.emit()
              }
              break
            }
          }
          const result = readTurn(entries, n.requestId)
          if (n.endSeq !== null && result.endSeq === null) {
            fail(new Error('未能读取此节点的完整问答，请刷新后重试'))
            return
          }
          if (this.answers.get(n.id) === result.answer && result.endSeq === null) return
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
                error:
                  status === 'failed'
                    ? result.reason.error?.message ||
                      result.reason.message ||
                      '本轮生成未完成（' + result.reason.kind + '）'
                    : null,
              }).then(stop, async (e) => {
                stop()
                try {
                  await this.refresh()
                } catch {
                  fail(e)
                }
              })
          }
          this.answerSource(n.id).emit()
        }
        // Coalesce stream tokens before folding history and parsing Markdown.
        off = binding.eventSource.subscribe(() => {
          if (timer !== undefined || stopped || finishing) return
          timer = setTimeout(() => {
            timer = undefined
            read()
          }, 100)
        })
        read()
      })
      .catch(fail)
  }
  dispose() {
    this.closing = true
    this.composers.dispose()
    this.pendingStop()
    for (const stop of [...this.watches.values()]) stop()
    this.listeners.clear()
  }
}
