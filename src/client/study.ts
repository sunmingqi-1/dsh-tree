import { TreeLog, quoteText } from '../treeLog.js'
import { isQuoteBranch, readTurn, type Turn, type Anchor } from './tree'
import { NativeDrafts } from './nativeDrafts'
import { NativeTurns, NativeInteractions } from './nativeState'
import { bindBranchInput, sendBranchPrompt } from './branchPrompt'
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
  // Keep existing temporary IDs out of the workspace list after upgrading.
  readerDrafts = (() => {
    try {
      return JSON.parse(localStorage.getItem('dsh-study-tree:reader-drafts') || '{}')
    } catch {
      return {}
    }
  })()
  active: string | null = null
  navigation: { id: string | null; revision: number } | null = null
  workspaceId: string | undefined
  turnNumbers = new Map<string, number>()
  nodes: Turn[] = []
  answers = new Map<string, string>()
  private turnAnswers = new Map<string, Map<number, string>>()
  answerFor(node: Turn) {
    const parts = this.turnAnswers.get(node.id)
    return parts && node.activeTurns
      ? node.activeTurns.map(turn => parts.get(turn)).filter(Boolean).join('\n\n')
      : this.answers.get(node.id)
  }
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
    this.stopFollowing()
    this.creating = true
    this.pendingStop()
    this.pendingSession = null
    this.workspaceId = workspaceId
    this.ctx.uiWorkspace.startSession(workspaceId)
    this.emit()
  }
  rootReady = false
  private followed: string | null = null
  private stopFollowing = () => {}
  private sent = new Map<string, { active: string | null; revision: number; root: boolean; requestId: string }>()
  private selectionRevision = 0
  setActive(id: string | null) {
    if (this.active !== id) this.selectionRevision++
    this.active = id
  }
  onSubmission(id: string, root = false) {
    const active = this.active, revision = this.selectionRevision
    return (requestId: string) => { this.sent.set(id, { active, revision, root, requestId }) }
  }
  forgetSubmission(id: string) { this.sent.delete(id) }
  armRoot(sessionId) {
    if (this.pendingSession === sessionId) return
    this.pendingStop()
    this.rootReady = false
    this.creating = true
    this.pendingSession = sessionId
    this.follow(sessionId)
    const ref = this.ctx.sessions.retain(sessionId, { source: 'studyTree.root' })
    let alive = true, unbind = () => {}
    this.pendingStop = () => {
      if (!alive) return
      alive = false
      this.rootReady = false
      this.pendingSession = null
      unbind()
      ref.release()
    }
    void ref.ready.then(binding => {
      if (!alive) return
      unbind = bindBranchInput(this, binding, sessionId, () => {
        const id = crypto.randomUUID()
        return { parentSeq: null, metadata: { studyTree: { id } }, onRequest: this.onSubmission(id, true) }
      })
      this.rootReady = true
      this.emit()
    }).catch(error => { if (alive) { this.error = error.message; this.emit() } })
    this.emit()
  }
  /** A single resident subscription learns about submissions from every window. */
  follow(sessionId) {
    if (this.followed === sessionId) return
    this.stopFollowing()
    this.followed = sessionId
    const ref = this.ctx.sessions.retain(sessionId, { source: 'studyTree.log' })
    let alive = true, off = () => {}
    this.stopFollowing = () => {
      if (!alive) return
      alive = false
      off()
      ref.release()
      this.followed = null
    }
    void ref.ready.then(async binding => {
      await binding.session.loadThrough(0)
      if (!alive) return
      const log = new TreeLog(sessionId)
      let revision = -1
      const read = () => {
        const window = binding.eventSource.getSnapshot()
        const delta = revision >= 0 && revision + 1 === window.revision ? window.change : null
        revision = window.revision
        const entries = delta?.kind === 'append' ? delta.entries : delta?.kind === 'settle-assistant'
          ? (delta.entry ? [delta.entry] : []) : window.entries
        let first = entries.length
        while (first && entries[first - 1].event.seq >= log.nextSeq) first--
        const changes = new Map()
        for (let i = first; i < entries.length; i++) {
          if (entries[i].type === 'transient') continue
          const row = log.append(entries[i].event)
          if (row) changes.set(row.id, row)
        }
        if (!changes.size) return
        const merged = new Map(this.nodes.map(row => [row.id, row]))
        for (const row of changes.values()) {
          const old = merged.get(row.id)
          if (row.continuations?.length && (old?.endSeq !== row.endSeq || old?.activeTurns?.at(-1) !== row.activeTurns?.at(-1)))
            this.answers.delete(row.id)
          merged.set(row.id, { ...old, ...row, revision: old?.revision || 0 })
          this.turnNumbers.set(row.id, row.turn)
        }
        this.nodes = [...merged.values()]
        for (const row of changes.values()) {
          const intent = this.sent.get(row.id)
          if (!intent || row.requestId !== intent.requestId) continue
          this.sent.delete(row.id)
          if (intent.root && this.creating && this.pendingSession === sessionId) {
            this.creating = false
            this.pendingStop()
            this.open(row.id)
          } else if (!intent.root && this.enabled && intent.active === this.active && intent.revision === this.selectionRevision) this.open(row.id)
        }
        this.emit()
      }
      off = binding.eventSource.subscribe(read)
      read()
    }).catch(error => { if (alive) { this.error = error.message; this.emit() } })
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
    this.setActive(id)
    if (node.logged && node.sessionId) this.follow(node.sessionId)
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
      const previous = revisions.get(row.id)
      if (row.logged) {
        this.turnNumbers.set(row.id, row.turn)
        const turn = previous?.logged && (previous.boundarySeq ?? -1) > (row.boundarySeq ?? -1) ? previous : row
        const annotation = previous?.logged && previous.revision > row.revision ? previous : row
        revisions.set(row.id, { ...turn, revision: annotation.revision, title: annotation.title, mark: annotation.mark })
      } else if ((previous?.revision ?? -1) < row.revision) revisions.set(row.id, row)
    }
    this.nodes = Array.from(revisions.values())
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
    const old = this.nodes.find(n => n.id === saved.id)
    this.merge(old?.logged ? { ...old, title: saved.title, mark: saved.mark, revision: saved.revision } : saved)
    this.emit()
    return saved as Turn
  }
  async submit(
    parent: Turn | null,
    question: string,
    anchor: Anchor | null,
    versionOf?: string,
  ) {
    if (!parent && versionOf && !this.nodes.find(n => n.id === versionOf)?.logged) throw new Error('旧版学习树仅支持阅读。请新建学习主题继续。')
    if (parent && (parent.endSeq == null || !parent.sessionId))
      throw new Error('请等待来源回答结束')
    if (parent && !parent.logged) throw new Error('旧版学习树仅支持阅读。请新建学习主题继续。')
    if (parent) parent = this.nodes.find(n => n.id === parent.id) ?? parent
    // Rewriting the root starts another independent tree with empty history.
    const sessionId = parent?.sessionId || await this.ctx.sessions.create({ workspaceId: this.workspaceId })
    this.follow(sessionId)
    await this.ctx.sessions.using(sessionId, { source: 'studyTree' }, async ref => {
      const binding = await ref.ready
      const id = crypto.randomUUID()
      const text = anchor ? quoteText(anchor.text) + '\n\n' + question : question
      const handle = binding.session.beginSubmission({ text, mode: 'queue', attachments: [] })
      const original = versionOf && this.nodes.find(n => n.id === versionOf)
      const branchKind = (original ? isQuoteBranch(original) : !!anchor) ? 'quote' : 'card'
      const meta = { studyTree: { id, ...(parent && { branchKind }), ...(versionOf && { versionOf }), ...(anchor && { anchor }) } }
      await sendBranchPrompt(this, sessionId, binding.session, handle, {
        parentSeq: parent?.boundarySeq ?? parent?.endSeq ?? null, metadata: meta, onRequest: this.onSubmission(id),
      }, [{ type: 'text', text }])
    })
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
          if (!n.logged) for (const { event } of entries) {
            if (event.type === 'turn/start') turnNumber = event.data.turn
            if (event.type === 'user/message' && event.data.source?.rpcId === n.requestId) {
              if (turnNumber !== undefined && this.turnNumbers.get(n.id) !== turnNumber) {
                this.turnNumbers.set(n.id, turnNumber)
                this.emit()
              }
              break
            }
          }
          const current = this.nodes.find(node => node.id === n.id) || n
          const primary = readTurn(entries, n.requestId, n.startSeq)
          let result = primary
          if (current.continuations?.length) {
            const parts = new Map([[current.turn, primary.answer]])
            for (const part of current.continuations) {
              const tail = readTurn(entries, undefined, part.startSeq)
              parts.set(part.turn, tail.answer)
              if (part.turn === current.activeTurns?.at(-1)) result = tail
            }
            this.turnAnswers.set(n.id, parts)
            result = { ...result, answer: this.answerFor(current) || '' }
          }
          if (current.endSeq !== null && result.endSeq === null) {
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
            if (n.logged || n.endSeq === result.endSeq) stop()
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
    this.stopFollowing()
    this.composers.dispose()
    this.pendingStop()
    for (const stop of [...this.watches.values()]) stop()
    this.listeners.clear()
  }
}
